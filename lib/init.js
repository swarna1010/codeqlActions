"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.installPythonDeps = exports.injectWindowsTracer = exports.runInit = exports.initConfig = exports.initCodeQL = exports.ToolsSource = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const toolrunner = __importStar(require("@actions/exec/lib/toolrunner"));
const safeWhich = __importStar(require("@chrisgavin/safe-which"));
const analysisPaths = __importStar(require("./analysis-paths"));
const codeql_1 = require("./codeql");
const configUtils = __importStar(require("./config-utils"));
const tracer_config_1 = require("./tracer-config");
const util = __importStar(require("./util"));
const util_1 = require("./util");
var ToolsSource;
(function (ToolsSource) {
    ToolsSource["Unknown"] = "UNKNOWN";
    ToolsSource["Local"] = "LOCAL";
    ToolsSource["Toolcache"] = "TOOLCACHE";
    ToolsSource["Download"] = "DOWNLOAD";
})(ToolsSource = exports.ToolsSource || (exports.ToolsSource = {}));
async function initCodeQL(toolsInput, apiDetails, tempDir, variant, defaultCliVersion, logger) {
    logger.startGroup("Setup CodeQL tools");
    const { codeql, toolsDownloadDurationMs, toolsSource, toolsVersion } = await (0, codeql_1.setupCodeQL)(toolsInput, apiDetails, tempDir, variant, defaultCliVersion, logger, true);
    await codeql.printVersion();
    logger.endGroup();
    return { codeql, toolsDownloadDurationMs, toolsSource, toolsVersion };
}
exports.initCodeQL = initCodeQL;
async function initConfig(languagesInput, queriesInput, packsInput, threatModelsInput, registriesInput, configFile, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger) {
    logger.startGroup("Load language configuration");
    const config = await configUtils.initConfig(languagesInput, queriesInput, packsInput, threatModelsInput, registriesInput, configFile, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger);
    analysisPaths.printPathFiltersWarning(config, logger);
    logger.endGroup();
    return config;
}
exports.initConfig = initConfig;
async function runInit(codeql, config, sourceRoot, processName, registriesInput, features, apiDetails, logger) {
    fs.mkdirSync(config.dbLocation, { recursive: true });
    try {
        if (await (0, util_1.codeQlVersionAbove)(codeql, codeql_1.CODEQL_VERSION_NEW_TRACING)) {
            // When parsing the codeql config in the CLI, we have not yet created the qlconfig file.
            // So, create it now.
            // If we are parsing the config file in the Action, then the qlconfig file was already created
            // before the `pack download` command was invoked. It is not required for the init command.
            let registriesAuthTokens;
            let qlconfigFile;
            if (await util.useCodeScanningConfigInCli(codeql, features)) {
                ({ registriesAuthTokens, qlconfigFile } =
                    await configUtils.generateRegistries(registriesInput, codeql, config.tempDir, logger));
            }
            await configUtils.wrapEnvironment({
                GITHUB_TOKEN: apiDetails.auth,
                CODEQL_REGISTRIES_AUTH: registriesAuthTokens,
            }, 
            // Init a database cluster
            async () => await codeql.databaseInitCluster(config, sourceRoot, processName, features, qlconfigFile, logger));
        }
        else {
            for (const language of config.languages) {
                // Init language database
                await codeql.databaseInit(util.getCodeQLDatabasePath(config, language), language, sourceRoot);
            }
        }
    }
    catch (e) {
        throw processError(e);
    }
    return await (0, tracer_config_1.getCombinedTracerConfig)(config, codeql);
}
exports.runInit = runInit;
/**
 * Possibly convert this error into a UserError in order to avoid
 * counting this error towards our internal error budget.
 *
 * @param e The error to possibly convert to a UserError.
 *
 * @returns A UserError if the error is a known error that can be
 *         attributed to the user, otherwise the original error.
 */
function processError(e) {
    if (!(e instanceof Error)) {
        return e;
    }
    if (
    // Init action called twice
    e.message?.includes("Refusing to create databases") &&
        e.message?.includes("exists and is not an empty directory.")) {
        return new util.UserError(`Is the "init" action called twice in the same job? ${e.message}`);
    }
    if (
    // Version of CodeQL CLI is incompatible with this version of the CodeQL Action
    e.message?.includes("is not compatible with this CodeQL CLI") ||
        // Expected source location for database creation does not exist
        e.message?.includes("Invalid source root")) {
        return new util.UserError(e.message);
    }
    return e;
}
// Runs a powershell script to inject the tracer into a parent process
// so it can tracer future processes, hopefully including the build process.
// If processName is given then injects into the nearest parent process with
// this name, otherwise uses the processLevel-th parent if defined, otherwise
// defaults to the 3rd parent as a rough guess.
async function injectWindowsTracer(processName, processLevel, config, codeql, tracerConfig) {
    let script;
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
    }
    else {
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
    await new toolrunner.ToolRunner(await safeWhich.safeWhich("powershell"), [
        "-ExecutionPolicy",
        "Bypass",
        "-file",
        injectTracerPath,
        path.resolve(path.dirname(codeql.getPath()), "tools", "win64", "tracer.exe"),
    ], { env: { ODASA_TRACER_CONFIGURATION: tracerConfig.spec } }).exec();
}
exports.injectWindowsTracer = injectWindowsTracer;
async function installPythonDeps(codeql, logger) {
    logger.startGroup("Setup Python dependencies");
    const scriptsFolder = path.resolve(__dirname, "../python-setup");
    try {
        if (process.platform === "win32") {
            await new toolrunner.ToolRunner(await safeWhich.safeWhich("powershell"), [
                path.join(scriptsFolder, "install_tools.ps1"),
            ]).exec();
        }
        else {
            await new toolrunner.ToolRunner(path.join(scriptsFolder, "install_tools.sh")).exec();
        }
        const script = "auto_install_packages.py";
        if (process.platform === "win32") {
            await new toolrunner.ToolRunner(await safeWhich.safeWhich("py"), [
                "-3",
                "-B",
                path.join(scriptsFolder, script),
                path.dirname(codeql.getPath()),
            ]).exec();
        }
        else {
            await new toolrunner.ToolRunner(await safeWhich.safeWhich("python3"), [
                "-B",
                path.join(scriptsFolder, script),
                path.dirname(codeql.getPath()),
            ]).exec();
        }
    }
    catch (e) {
        logger.endGroup();
        logger.warning(`An error occurred while trying to automatically install Python dependencies: ${e}\n` +
            "Please make sure any necessary dependencies are installed before calling the codeql-action/analyze " +
            "step, and add a 'setup-python-dependencies: false' argument to this step to disable our automatic " +
            "dependency installation and avoid this warning.");
        return;
    }
    logger.endGroup();
}
exports.installPythonDeps = installPythonDeps;
//# sourceMappingURL=init.js.map