import * as fs from "fs";
import * as path from "path";

import * as toolrunner from "@actions/exec/lib/toolrunner";
import * as safeWhich from "@chrisgavin/safe-which";

import * as analysisPaths from "./analysis-paths";
import { GitHubApiCombinedDetails, GitHubApiDetails } from "./api-client";
import { CodeQL, CODEQL_VERSION_NEW_TRACING, setupCodeQL } from "./codeql";
import * as configUtils from "./config-utils";
import { CodeQLDefaultVersionInfo, FeatureEnablement } from "./feature-flags";
import { Logger } from "./logging";
import { RepositoryNwo } from "./repository";
import { TracerConfig, getCombinedTracerConfig } from "./tracer-config";
import * as util from "./util";
import { codeQlVersionAbove } from "./util";

export enum ToolsSource {
  Unknown = "UNKNOWN",
  Local = "LOCAL",
  Toolcache = "TOOLCACHE",
  Download = "DOWNLOAD",
}

export async function initCodeQL(
  toolsInput: string | undefined,
  apiDetails: GitHubApiDetails,
  tempDir: string,
  variant: util.GitHubVariant,
  defaultCliVersion: CodeQLDefaultVersionInfo,
  logger: Logger
): Promise<{
  codeql: CodeQL;
  toolsDownloadDurationMs?: number;
  toolsSource: ToolsSource;
  toolsVersion: string;
}> {
  logger.startGroup("Setup CodeQL tools");
  const { codeql, toolsDownloadDurationMs, toolsSource, toolsVersion } =
    await setupCodeQL(
      toolsInput,
      apiDetails,
      tempDir,
      variant,
      defaultCliVersion,
      logger,
      true
    );
  await codeql.printVersion();
  logger.endGroup();
  return { codeql, toolsDownloadDurationMs, toolsSource, toolsVersion };
}

export async function initConfig(
  languagesInput: string | undefined,
  queriesInput: string | undefined,
  packsInput: string | undefined,
  threatModelsInput: string | undefined,
  registriesInput: string | undefined,
  configFile: string | undefined,
  dbLocation: string | undefined,
  trapCachingEnabled: boolean,
  debugMode: boolean,
  debugArtifactName: string,
  debugDatabaseName: string,
  repository: RepositoryNwo,
  tempDir: string,
  codeQL: CodeQL,
  workspacePath: string,
  gitHubVersion: util.GitHubVersion,
  apiDetails: GitHubApiCombinedDetails,
  features: FeatureEnablement,
  logger: Logger
): Promise<configUtils.Config> {
  logger.startGroup("Load language configuration");
  const config = await configUtils.initConfig(
    languagesInput,
    queriesInput,
    packsInput,
    threatModelsInput,
    registriesInput,
    configFile,
    dbLocation,
    trapCachingEnabled,
    debugMode,
    debugArtifactName,
    debugDatabaseName,
    repository,
    tempDir,
    codeQL,
    workspacePath,
    gitHubVersion,
    apiDetails,
    features,
    logger
  );
  analysisPaths.printPathFiltersWarning(config, logger);
  logger.endGroup();
  return config;
}

export async function runInit(
  codeql: CodeQL,
  config: configUtils.Config,
  sourceRoot: string,
  processName: string | undefined,
  registriesInput: string | undefined,
  features: FeatureEnablement,
  apiDetails: GitHubApiCombinedDetails,
  logger: Logger
): Promise<TracerConfig | undefined> {
  fs.mkdirSync(config.dbLocation, { recursive: true });

  try {
    if (await codeQlVersionAbove(codeql, CODEQL_VERSION_NEW_TRACING)) {
      // When parsing the codeql config in the CLI, we have not yet created the qlconfig file.
      // So, create it now.
      // If we are parsing the config file in the Action, then the qlconfig file was already created
      // before the `pack download` command was invoked. It is not required for the init command.
      let registriesAuthTokens: string | undefined;
      let qlconfigFile: string | undefined;
      if (await util.useCodeScanningConfigInCli(codeql, features)) {
        ({ registriesAuthTokens, qlconfigFile } =
          await configUtils.generateRegistries(
            registriesInput,
            codeql,
            config.tempDir,
            logger
          ));
      }
      await configUtils.wrapEnvironment(
        {
          GITHUB_TOKEN: apiDetails.auth,
          CODEQL_REGISTRIES_AUTH: registriesAuthTokens,
        },

        // Init a database cluster
        async () =>
          await codeql.databaseInitCluster(
            config,
            sourceRoot,
            processName,
            features,
            qlconfigFile,
            logger
          )
      );
    } else {
      for (const language of config.languages) {
        // Init language database
        await codeql.databaseInit(
          util.getCodeQLDatabasePath(config, language),
          language,
          sourceRoot
        );
      }
    }
  } catch (e) {
    throw processError(e);
  }
  return await getCombinedTracerConfig(config, codeql);
}

/**
 * Possibly convert this error into a UserError in order to avoid
 * counting this error towards our internal error budget.
 *
 * @param e The error to possibly convert to a UserError.
 *
 * @returns A UserError if the error is a known error that can be
 *         attributed to the user, otherwise the original error.
 */
function processError(e: any): Error {
  if (!(e instanceof Error)) {
    return e;
  }

  if (
    // Init action called twice
    e.message?.includes("Refusing to create databases") &&
    e.message?.includes("exists and is not an empty directory.")
  ) {
    return new util.UserError(
      `Is the "init" action called twice in the same job? ${e.message}`
    );
  }

  if (
    // Version of CodeQL CLI is incompatible with this version of the CodeQL Action
    e.message?.includes("is not compatible with this CodeQL CLI") ||
    // Expected source location for database creation does not exist
    e.message?.includes("Invalid source root")
  ) {
    return new util.UserError(e.message);
  }

  return e;
}

// Runs a powershell script to inject the tracer into a parent process
// so it can tracer future processes, hopefully including the build process.
// If processName is given then injects into the nearest parent process with
// this name, otherwise uses the processLevel-th parent if defined, otherwise
// defaults to the 3rd parent as a rough guess.
export async function injectWindowsTracer(
  processName: string | undefined,
  processLevel: number | undefined,
  config: configUtils.Config,
  codeql: CodeQL,
  tracerConfig: TracerConfig
) {
  let script: string;
  if (processName !== undefined) {
    script = `
      Param(
          [Parameter(Position=0)]
          [String]
          $tracer
      )

      $id = $PID
      while ($true) {
        $p = Get-CimInstance -Class Win32_Process -Filter "ProcessId = $id"
        Write-Host "Found process: $p"
        if ($p -eq $null) {
          throw "Could not determine ${processName} process"
        }
        if ($p[0].Name -eq "${processName}") {
          Break
        } else {
          $id = $p[0].ParentProcessId
        }
      }
      Write-Host "Final process: $p"

      Invoke-Expression "&$tracer --inject=$id"`;
  } else {
    // If the level is not defined then guess at the 3rd parent process.
    // This won't be correct in every setting but it should be enough in most settings,
    // and overestimating is likely better in this situation so we definitely trace
    // what we want, though this does run the risk of interfering with future CI jobs.
    // Note that the default of 3 doesn't work on github actions, so we include a
    // special case in the script that checks for Runner.Worker.exe so we can still work
    // on actions if the runner is invoked there.
    processLevel = processLevel || 3;
    script = `
      Param(
          [Parameter(Position=0)]
          [String]
          $tracer
      )

      $id = $PID
      for ($i = 0; $i -le ${processLevel}; $i++) {
        $p = Get-CimInstance -Class Win32_Process -Filter "ProcessId = $id"
        Write-Host "Parent process \${i}: $p"
        if ($p -eq $null) {
          throw "Process tree ended before reaching required level"
        }
        # Special case just in case the runner is used on actions
        if ($p[0].Name -eq "Runner.Worker.exe") {
          Write-Host "Found Runner.Worker.exe process which means we are running on GitHub Actions"
          Write-Host "Aborting search early and using process: $p"
          Break
        } elseif ($p[0].Name -eq "Agent.Worker.exe") {
          Write-Host "Found Agent.Worker.exe process which means we are running on Azure Pipelines"
          Write-Host "Aborting search early and using process: $p"
          Break
        } else {
          $id = $p[0].ParentProcessId
        }
      }
      Write-Host "Final process: $p"

      Invoke-Expression "&$tracer --inject=$id"`;
  }

  const injectTracerPath = path.join(config.tempDir, "inject-tracer.ps1");
  fs.writeFileSync(injectTracerPath, script);

  await new toolrunner.ToolRunner(
    await safeWhich.safeWhich("powershell"),
    [
      "-ExecutionPolicy",
      "Bypass",
      "-file",
      injectTracerPath,
      path.resolve(
        path.dirname(codeql.getPath()),
        "tools",
        "win64",
        "tracer.exe"
      ),
    ],
    { env: { ODASA_TRACER_CONFIGURATION: tracerConfig.spec } }
  ).exec();
}

export async function installPythonDeps(codeql: CodeQL, logger: Logger) {
  logger.startGroup("Setup Python dependencies");

  const scriptsFolder = path.resolve(__dirname, "../python-setup");

  try {
    if (process.platform === "win32") {
      await new toolrunner.ToolRunner(await safeWhich.safeWhich("powershell"), [
        path.join(scriptsFolder, "install_tools.ps1"),
      ]).exec();
    } else {
      await new toolrunner.ToolRunner(
        path.join(scriptsFolder, "install_tools.sh")
      ).exec();
    }
    const script = "auto_install_packages.py";
    if (process.platform === "win32") {
      await new toolrunner.ToolRunner(await safeWhich.safeWhich("py"), [
        "-3",
        "-B",
        path.join(scriptsFolder, script),
        path.dirname(codeql.getPath()),
      ]).exec();
    } else {
      await new toolrunner.ToolRunner(await safeWhich.safeWhich("python3"), [
        "-B",
        path.join(scriptsFolder, script),
        path.dirname(codeql.getPath()),
      ]).exec();
    }
  } catch (e) {
    logger.endGroup();
    logger.warning(
      `An error occurred while trying to automatically install Python dependencies: ${e}\n` +
        "Please make sure any necessary dependencies are installed before calling the codeql-action/analyze " +
        "step, and add a 'setup-python-dependencies: false' argument to this step to disable our automatic " +
        "dependency installation and avoid this warning."
    );
    return;
  }
  logger.endGroup();
}
