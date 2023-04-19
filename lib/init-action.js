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
const path = __importStar(require("path"));
const core = __importStar(require("@actions/core"));
const actions_util_1 = require("./actions-util");
const api_client_1 = require("./api-client");
const codeql_1 = require("./codeql");
const feature_flags_1 = require("./feature-flags");
const init_1 = require("./init");
const languages_1 = require("./languages");
const logging_1 = require("./logging");
const repository_1 = require("./repository");
const trap_caching_1 = require("./trap-caching");
const util_1 = require("./util");
const workflow_1 = require("./workflow");
async function sendCompletedStatusReport(startedAt, config, toolsDownloadDurationMs, toolsFeatureFlagsValid, toolsSource, toolsVersion, logger, error) {
    const statusReportBase = await (0, actions_util_1.createStatusReportBase)("init", (0, actions_util_1.getActionsStatus)(error), startedAt, error?.message, error?.stack);
    const workflowLanguages = (0, actions_util_1.getOptionalInput)("languages");
    const initStatusReport = {
        ...statusReportBase,
        tools_input: (0, actions_util_1.getOptionalInput)("tools") || "",
        tools_resolved_version: toolsVersion,
        tools_source: toolsSource || init_1.ToolsSource.Unknown,
        workflow_languages: workflowLanguages || "",
    };
    const initToolsDownloadFields = {};
    if (toolsDownloadDurationMs !== undefined) {
        initToolsDownloadFields.tools_download_duration_ms =
            toolsDownloadDurationMs;
    }
    if (toolsFeatureFlagsValid !== undefined) {
        initToolsDownloadFields.tools_feature_flags_valid = toolsFeatureFlagsValid;
    }
    if (config !== undefined) {
        const languages = config.languages.join(",");
        const paths = (config.originalUserInput.paths || []).join(",");
        const pathsIgnore = (config.originalUserInput["paths-ignore"] || []).join(",");
        const disableDefaultQueries = config.originalUserInput["disable-default-queries"]
            ? languages
            : "";
        const queries = [];
        let queriesInput = (0, actions_util_1.getOptionalInput)("queries")?.trim();
        if (queriesInput === undefined || queriesInput.startsWith("+")) {
            queries.push(...(config.originalUserInput.queries || []).map((q) => q.uses));
        }
        if (queriesInput !== undefined) {
            queriesInput = queriesInput.startsWith("+")
                ? queriesInput.slice(1)
                : queriesInput;
            queries.push(...queriesInput.split(","));
        }
        // Append fields that are dependent on `config`
        const initWithConfigStatusReport = {
            ...initStatusReport,
            disable_default_queries: disableDefaultQueries,
            languages,
            ml_powered_javascript_queries: (0, util_1.getMlPoweredJsQueriesStatus)(config),
            paths,
            paths_ignore: pathsIgnore,
            queries: queries.join(","),
            trap_cache_languages: Object.keys(config.trapCaches).join(","),
            trap_cache_download_size_bytes: Math.round(await (0, trap_caching_1.getTotalCacheSize)(config.trapCaches, logger)),
            trap_cache_download_duration_ms: Math.round(config.trapCacheDownloadTime),
        };
        await (0, actions_util_1.sendStatusReport)({
            ...initWithConfigStatusReport,
            ...initToolsDownloadFields,
        });
    }
    else {
        await (0, actions_util_1.sendStatusReport)({ ...initStatusReport, ...initToolsDownloadFields });
    }
}
async function run() {
    const startedAt = new Date();
    const logger = (0, logging_1.getActionsLogger)();
    (0, util_1.initializeEnvironment)((0, actions_util_1.getActionVersion)());
    let config;
    let codeql;
    let toolsDownloadDurationMs;
    let toolsFeatureFlagsValid;
    let toolsSource;
    let toolsVersion;
    const apiDetails = {
        auth: (0, actions_util_1.getRequiredInput)("token"),
        externalRepoAuth: (0, actions_util_1.getOptionalInput)("external-repository-token"),
        url: (0, util_1.getRequiredEnvParam)("GITHUB_SERVER_URL"),
        apiURL: (0, util_1.getRequiredEnvParam)("GITHUB_API_URL"),
    };
    const gitHubVersion = await (0, api_client_1.getGitHubVersion)();
    (0, util_1.checkGitHubVersionInRange)(gitHubVersion, logger);
    const repositoryNwo = (0, repository_1.parseRepositoryNwo)((0, util_1.getRequiredEnvParam)("GITHUB_REPOSITORY"));
    const registriesInput = (0, actions_util_1.getOptionalInput)("registries");
    const features = new feature_flags_1.Features(gitHubVersion, repositoryNwo, (0, actions_util_1.getTemporaryDirectory)(), logger);
    try {
        const workflowErrors = await (0, workflow_1.validateWorkflow)(logger);
        if (!(await (0, actions_util_1.sendStatusReport)(await (0, actions_util_1.createStatusReportBase)("init", "starting", startedAt, workflowErrors)))) {
            return;
        }
        const codeQLDefaultVersionInfo = await features.getDefaultCliVersion(gitHubVersion.type);
        if (codeQLDefaultVersionInfo.variant === util_1.GitHubVariant.DOTCOM) {
            toolsFeatureFlagsValid = codeQLDefaultVersionInfo.toolsFeatureFlagsValid;
        }
        const initCodeQLResult = await (0, init_1.initCodeQL)((0, actions_util_1.getOptionalInput)("tools"), apiDetails, (0, actions_util_1.getTemporaryDirectory)(), gitHubVersion.type, codeQLDefaultVersionInfo, logger);
        codeql = initCodeQLResult.codeql;
        toolsDownloadDurationMs = initCodeQLResult.toolsDownloadDurationMs;
        toolsVersion = initCodeQLResult.toolsVersion;
        toolsSource = initCodeQLResult.toolsSource;
        await (0, codeql_1.enrichEnvironment)(codeql);
        config = await (0, init_1.initConfig)((0, actions_util_1.getOptionalInput)("languages"), (0, actions_util_1.getOptionalInput)("queries"), (0, actions_util_1.getOptionalInput)("packs"), (0, actions_util_1.getOptionalInput)("threat-models"), registriesInput, (0, actions_util_1.getOptionalInput)("config-file"), (0, actions_util_1.getOptionalInput)("db-location"), getTrapCachingEnabled(), 
        // Debug mode is enabled if:
        // - The `init` Action is passed `debug: true`.
        // - Actions step debugging is enabled (e.g. by [enabling debug logging for a rerun](https://docs.github.com/en/actions/managing-workflow-runs/re-running-workflows-and-jobs#re-running-all-the-jobs-in-a-workflow),
        //   or by setting the `ACTIONS_STEP_DEBUG` secret to `true`).
        (0, actions_util_1.getOptionalInput)("debug") === "true" || core.isDebug(), (0, actions_util_1.getOptionalInput)("debug-artifact-name") || util_1.DEFAULT_DEBUG_ARTIFACT_NAME, (0, actions_util_1.getOptionalInput)("debug-database-name") || util_1.DEFAULT_DEBUG_DATABASE_NAME, repositoryNwo, (0, actions_util_1.getTemporaryDirectory)(), codeql, (0, util_1.getRequiredEnvParam)("GITHUB_WORKSPACE"), gitHubVersion, apiDetails, features, logger);
        if (config.languages.includes(languages_1.Language.python) &&
            (0, actions_util_1.getRequiredInput)("setup-python-dependencies") === "true") {
            try {
                await (0, init_1.installPythonDeps)(codeql, logger);
            }
            catch (unwrappedError) {
                const error = (0, util_1.wrapError)(unwrappedError);
                logger.warning(`${error.message} You can call this action with 'setup-python-dependencies: false' to disable this process`);
            }
        }
    }
    catch (unwrappedError) {
        const error = (0, util_1.wrapError)(unwrappedError);
        core.setFailed(error.message);
        await (0, actions_util_1.sendStatusReport)(await (0, actions_util_1.createStatusReportBase)("init", "aborted", startedAt, error.message, error.stack));
        return;
    }
    try {
        // Forward Go flags
        const goFlags = process.env["GOFLAGS"];
        if (goFlags) {
            core.exportVariable("GOFLAGS", goFlags);
            core.warning("Passing the GOFLAGS env parameter to the init action is deprecated. Please move this to the analyze action.");
        }
        // Limit RAM and threads for extractors. When running extractors, the CodeQL CLI obeys the
        // CODEQL_RAM and CODEQL_THREADS environment variables to decide how much RAM and how many
        // threads it would ask extractors to use. See help text for the "--ram" and "--threads"
        // options at https://codeql.github.com/docs/codeql-cli/manual/database-trace-command/
        // for details.
        core.exportVariable("CODEQL_RAM", process.env["CODEQL_RAM"] ||
            (0, util_1.getMemoryFlagValue)((0, actions_util_1.getOptionalInput)("ram")).toString());
        core.exportVariable("CODEQL_THREADS", (0, util_1.getThreadsFlagValue)((0, actions_util_1.getOptionalInput)("threads"), logger).toString());
        // Disable Kotlin extractor if feature flag set
        if (await features.getValue(feature_flags_1.Feature.DisableKotlinAnalysisEnabled)) {
            core.exportVariable("CODEQL_EXTRACTOR_JAVA_AGENT_DISABLE_KOTLIN", "true");
        }
        const sourceRoot = path.resolve((0, util_1.getRequiredEnvParam)("GITHUB_WORKSPACE"), (0, actions_util_1.getOptionalInput)("source-root") || "");
        const tracerConfig = await (0, init_1.runInit)(codeql, config, sourceRoot, "Runner.Worker.exe", registriesInput, features, apiDetails, logger);
        if (tracerConfig !== undefined) {
            for (const [key, value] of Object.entries(tracerConfig.env)) {
                core.exportVariable(key, value);
            }
            if (process.platform === "win32" &&
                !(await (0, util_1.codeQlVersionAbove)(codeql, codeql_1.CODEQL_VERSION_NEW_TRACING))) {
                await (0, init_1.injectWindowsTracer)("Runner.Worker.exe", undefined, config, codeql, tracerConfig);
            }
        }
        core.setOutput("codeql-path", config.codeQLCmd);
    }
    catch (unwrappedError) {
        const error = (0, util_1.wrapError)(unwrappedError);
        core.setFailed(error.message);
        await sendCompletedStatusReport(startedAt, config, toolsDownloadDurationMs, toolsFeatureFlagsValid, toolsSource, toolsVersion, logger, error);
        return;
    }
    await sendCompletedStatusReport(startedAt, config, toolsDownloadDurationMs, toolsFeatureFlagsValid, toolsSource, toolsVersion, logger);
}
function getTrapCachingEnabled() {
    // If the workflow specified something always respect that
    const trapCaching = (0, actions_util_1.getOptionalInput)("trap-caching");
    if (trapCaching !== undefined)
        return trapCaching === "true";
    // On self-hosted runners which may have slow network access, disable TRAP caching by default
    if (!(0, util_1.isHostedRunner)())
        return false;
    // On hosted runners, enable TRAP caching by default
    return true;
}
async function runWrapper() {
    try {
        await run();
    }
    catch (error) {
        core.setFailed(`init action failed: ${(0, util_1.wrapError)(error).message}`);
    }
    await (0, util_1.checkForTimeout)();
}
void runWrapper();
//# sourceMappingURL=init-action.js.map