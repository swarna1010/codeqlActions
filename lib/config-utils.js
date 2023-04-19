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
exports.getGeneratedCodeScanningConfigPath = exports.wrapEnvironment = exports.generateRegistries = exports.downloadPacks = exports.getConfig = exports.getPathToParsedConfigFile = exports.initConfig = exports.parsePacks = exports.validatePackSpecification = exports.prettyPrintPack = exports.parsePacksSpecification = exports.parsePacksFromConfig = exports.calculateAugmentation = exports.getDefaultConfig = exports.getRawLanguages = exports.getLanguages = exports.getLanguagesInRepo = exports.getUnknownLanguagesError = exports.getNoLanguagesError = exports.getConfigFileDirectoryGivenMessage = exports.getConfigFileFormatInvalidMessage = exports.getConfigFileRepoFormatInvalidMessage = exports.getConfigFileDoesNotExistErrorMessage = exports.getConfigFileOutsideWorkspaceErrorMessage = exports.getLocalPathDoesNotExist = exports.getLocalPathOutsideOfRepository = exports.getPacksStrInvalid = exports.getPacksInvalid = exports.getPacksInvalidSplit = exports.getPathsInvalid = exports.getPathsIgnoreInvalid = exports.getQueryUsesInvalid = exports.getQueriesMissingUses = exports.getQueriesInvalid = exports.getDisableDefaultQueriesInvalid = exports.getNameInvalid = exports.validateAndSanitisePath = exports.defaultAugmentationProperties = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const perf_hooks_1 = require("perf_hooks");
const yaml = __importStar(require("js-yaml"));
const semver = __importStar(require("semver"));
const api = __importStar(require("./api-client"));
const codeql_1 = require("./codeql");
const externalQueries = __importStar(require("./external-queries"));
const feature_flags_1 = require("./feature-flags");
const languages_1 = require("./languages");
const trap_caching_1 = require("./trap-caching");
const util_1 = require("./util");
// Property names from the user-supplied config file.
const NAME_PROPERTY = "name";
const DISABLE_DEFAULT_QUERIES_PROPERTY = "disable-default-queries";
const QUERIES_PROPERTY = "queries";
const QUERIES_USES_PROPERTY = "uses";
const PATHS_IGNORE_PROPERTY = "paths-ignore";
const PATHS_PROPERTY = "paths";
const PACKS_PROPERTY = "packs";
/**
 * The default, empty augmentation properties. This is most useeful
 * for tests.
 */
exports.defaultAugmentationProperties = {
    queriesInputCombines: false,
    packsInputCombines: false,
    threatModelsInputCombines: false,
    injectedMlQueries: false,
    packsInput: undefined,
    queriesInput: undefined,
    threatModelsInput: undefined,
};
/**
 * A list of queries from https://github.com/github/codeql that
 * we don't want to run. Disabling them here is a quicker alternative to
 * disabling them in the code scanning query suites. Queries should also
 * be disabled in the suites, and removed from this list here once the
 * bundle is updated to make those suite changes live.
 *
 * Format is a map from language to an array of path suffixes of .ql files.
 */
const DISABLED_BUILTIN_QUERIES = {
    csharp: [
        "ql/src/Security Features/CWE-937/VulnerablePackage.ql",
        "ql/src/Security Features/CWE-451/MissingXFrameOptions.ql",
    ],
};
function queryIsDisabled(language, query) {
    return (DISABLED_BUILTIN_QUERIES[language] || []).some((disabledQuery) => query.endsWith(disabledQuery));
}
/**
 * Asserts that the noDeclaredLanguage and multipleDeclaredLanguages fields are
 * both empty and errors if they are not.
 */
function validateQueries(resolvedQueries) {
    const noDeclaredLanguage = resolvedQueries.noDeclaredLanguage;
    const noDeclaredLanguageQueries = Object.keys(noDeclaredLanguage);
    if (noDeclaredLanguageQueries.length !== 0) {
        throw new Error(`${"The following queries do not declare a language. " +
            "Their qlpack.yml files are either missing or is invalid.\n"}${noDeclaredLanguageQueries.join("\n")}`);
    }
    const multipleDeclaredLanguages = resolvedQueries.multipleDeclaredLanguages;
    const multipleDeclaredLanguagesQueries = Object.keys(multipleDeclaredLanguages);
    if (multipleDeclaredLanguagesQueries.length !== 0) {
        throw new Error(`${"The following queries declare multiple languages. " +
            "Their qlpack.yml files are either missing or is invalid.\n"}${multipleDeclaredLanguagesQueries.join("\n")}`);
    }
}
/**
 * Run 'codeql resolve queries' and add the results to resultMap
 *
 * If a checkout path is given then the queries are assumed to be custom queries
 * and an error will be thrown if there is anything invalid about the queries.
 * If a checkout path is not given then the queries are assumed to be builtin
 * queries, and error checking will be suppressed.
 */
async function runResolveQueries(codeQL, resultMap, toResolve, extraSearchPath) {
    const resolvedQueries = await codeQL.resolveQueries(toResolve, extraSearchPath);
    if (extraSearchPath !== undefined) {
        validateQueries(resolvedQueries);
    }
    for (const [language, queryPaths] of Object.entries(resolvedQueries.byLanguage)) {
        if (resultMap[language] === undefined) {
            resultMap[language] = {
                builtin: [],
                custom: [],
            };
        }
        const queries = Object.keys(queryPaths).filter((q) => !queryIsDisabled(language, q));
        if (extraSearchPath !== undefined) {
            resultMap[language].custom.push({
                searchPath: extraSearchPath,
                queries,
            });
        }
        else {
            resultMap[language].builtin.push(...queries);
        }
    }
}
/**
 * Get the set of queries included by default.
 */
async function addDefaultQueries(codeQL, languages, resultMap) {
    const suites = languages.map((l) => `${l}-code-scanning.qls`);
    await runResolveQueries(codeQL, resultMap, suites, undefined);
}
// The set of acceptable values for built-in suites from the codeql bundle
const builtinSuites = [
    "security-experimental",
    "security-extended",
    "security-and-quality",
];
/**
 * Determine the set of queries associated with suiteName's suites and add them to resultMap.
 * Throws an error if suiteName is not a valid builtin suite.
 * May inject ML queries, and the return value will declare if this was done.
 */
async function addBuiltinSuiteQueries(languages, codeQL, resultMap, packs, suiteName, features, configFile) {
    let injectedMlQueries = false;
    const found = builtinSuites.find((suite) => suite === suiteName);
    if (!found) {
        throw new Error(getQueryUsesInvalid(configFile, suiteName));
    }
    if (suiteName === "security-experimental" &&
        !(await (0, util_1.codeQlVersionAbove)(codeQL, codeql_1.CODEQL_VERSION_SECURITY_EXPERIMENTAL_SUITE))) {
        throw new Error(`The 'security-experimental' suite is not supported on CodeQL CLI versions earlier than
      ${codeql_1.CODEQL_VERSION_SECURITY_EXPERIMENTAL_SUITE}. Please upgrade to CodeQL CLI version
      ${codeql_1.CODEQL_VERSION_SECURITY_EXPERIMENTAL_SUITE} or later.`);
    }
    // If we're running the JavaScript security-extended analysis (or a superset of it), the repo is
    // opted into the ML-powered queries beta, and a user hasn't already added the ML-powered query
    // pack, then add the ML-powered query pack so that we run ML-powered queries.
    if (
    // Only run ML-powered queries on Windows if we have a CLI that supports it.
    (process.platform !== "win32" ||
        (await (0, util_1.codeQlVersionAbove)(codeQL, codeql_1.CODEQL_VERSION_ML_POWERED_QUERIES_WINDOWS))) &&
        languages.includes("javascript") &&
        (found === "security-experimental" ||
            found === "security-extended" ||
            found === "security-and-quality") &&
        !packs.javascript?.some(isMlPoweredJsQueriesPack) &&
        (await features.getValue(feature_flags_1.Feature.MlPoweredQueriesEnabled, codeQL))) {
        if (!packs.javascript) {
            packs.javascript = [];
        }
        packs.javascript.push(await (0, util_1.getMlPoweredJsQueriesPack)(codeQL));
        injectedMlQueries = true;
    }
    const suites = languages.map((l) => `${l}-${suiteName}.qls`);
    await runResolveQueries(codeQL, resultMap, suites, undefined);
    return injectedMlQueries;
}
function isMlPoweredJsQueriesPack(pack) {
    return parsePacksSpecification(pack).name === util_1.ML_POWERED_JS_QUERIES_PACK_NAME;
}
/**
 * Retrieve the set of queries at localQueryPath and add them to resultMap.
 */
async function addLocalQueries(codeQL, resultMap, localQueryPath, workspacePath, configFile) {
    // Resolve the local path against the workspace so that when this is
    // passed to codeql it resolves to exactly the path we expect it to resolve to.
    let absoluteQueryPath = path.join(workspacePath, localQueryPath);
    // Check the file exists
    if (!fs.existsSync(absoluteQueryPath)) {
        throw new Error(getLocalPathDoesNotExist(configFile, localQueryPath));
    }
    // Call this after checking file exists, because it'll fail if file doesn't exist
    absoluteQueryPath = fs.realpathSync(absoluteQueryPath);
    // Check the local path doesn't jump outside the repo using '..' or symlinks
    if (!(absoluteQueryPath + path.sep).startsWith(fs.realpathSync(workspacePath) + path.sep)) {
        throw new Error(getLocalPathOutsideOfRepository(configFile, localQueryPath));
    }
    const extraSearchPath = workspacePath;
    await runResolveQueries(codeQL, resultMap, [absoluteQueryPath], extraSearchPath);
}
/**
 * Retrieve the set of queries at the referenced remote repo and add them to resultMap.
 */
async function addRemoteQueries(codeQL, resultMap, queryUses, tempDir, apiDetails, logger, configFile) {
    let tok = queryUses.split("@");
    if (tok.length !== 2) {
        throw new Error(getQueryUsesInvalid(configFile, queryUses));
    }
    const ref = tok[1];
    tok = tok[0].split("/");
    // The first token is the owner
    // The second token is the repo
    // The rest is a path, if there is more than one token combine them to form the full path
    if (tok.length < 2) {
        throw new Error(getQueryUsesInvalid(configFile, queryUses));
    }
    // Check none of the parts of the repository name are empty
    if (tok[0].trim() === "" || tok[1].trim() === "") {
        throw new Error(getQueryUsesInvalid(configFile, queryUses));
    }
    const nwo = `${tok[0]}/${tok[1]}`;
    // Checkout the external repository
    const checkoutPath = await externalQueries.checkoutExternalRepository(nwo, ref, apiDetails, tempDir, logger);
    const queryPath = tok.length > 2
        ? path.join(checkoutPath, tok.slice(2).join("/"))
        : checkoutPath;
    await runResolveQueries(codeQL, resultMap, [queryPath], checkoutPath);
}
/**
 * Parse a query 'uses' field to a discrete set of query files and update resultMap.
 *
 * The logic for parsing the string is based on what actions does for
 * parsing the 'uses' actions in the workflow file. So it can handle
 * local paths starting with './', or references to remote repos, or
 * a finite set of hardcoded terms for builtin suites.
 *
 * This may inject ML queries into the packs to use, and the return value will
 * declare if this was done.
 *
 * @returns whether or not we injected ML queries into the packs
 */
async function parseQueryUses(languages, codeQL, resultMap, packs, queryUses, tempDir, workspacePath, apiDetails, features, logger, configFile) {
    queryUses = queryUses.trim();
    if (queryUses === "") {
        throw new Error(getQueryUsesInvalid(configFile));
    }
    // Check for the local path case before we start trying to parse the repository name
    if (queryUses.startsWith("./")) {
        await addLocalQueries(codeQL, resultMap, queryUses.slice(2), workspacePath, configFile);
        return false;
    }
    // Check for one of the builtin suites
    if (queryUses.indexOf("/") === -1 && queryUses.indexOf("@") === -1) {
        return await addBuiltinSuiteQueries(languages, codeQL, resultMap, packs, queryUses, features, configFile);
    }
    // Otherwise, must be a reference to another repo.
    // If config parsing is handled in CLI, then this repo will be downloaded
    // later by the CLI.
    if (!(await (0, util_1.useCodeScanningConfigInCli)(codeQL, features))) {
        await addRemoteQueries(codeQL, resultMap, queryUses, tempDir, apiDetails, logger, configFile);
    }
    return false;
}
// Regex validating stars in paths or paths-ignore entries.
// The intention is to only allow ** to appear when immediately
// preceded and followed by a slash.
const pathStarsRegex = /.*(?:\*\*[^/].*|\*\*$|[^/]\*\*.*)/;
// Characters that are supported by filters in workflows, but not by us.
// See https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions#filter-pattern-cheat-sheet
const filterPatternCharactersRegex = /.*[?+[\]!].*/;
// Checks that a paths of paths-ignore entry is valid, possibly modifying it
// to make it valid, or if not possible then throws an error.
function validateAndSanitisePath(originalPath, propertyName, configFile, logger) {
    // Take a copy so we don't modify the original path, so we can still construct error messages
    let newPath = originalPath;
    // All paths are relative to the src root, so strip off leading slashes.
    while (newPath.charAt(0) === "/") {
        newPath = newPath.substring(1);
    }
    // Trailing ** are redundant, so strip them off
    if (newPath.endsWith("/**")) {
        newPath = newPath.substring(0, newPath.length - 2);
    }
    // An empty path is not allowed as it's meaningless
    if (newPath === "") {
        throw new Error(getConfigFilePropertyError(configFile, propertyName, `"${originalPath}" is not an invalid path. ` +
            `It is not necessary to include it, and it is not allowed to exclude it.`));
    }
    // Check for illegal uses of **
    if (newPath.match(pathStarsRegex)) {
        throw new Error(getConfigFilePropertyError(configFile, propertyName, `"${originalPath}" contains an invalid "**" wildcard. ` +
            `They must be immediately preceded and followed by a slash as in "/**/", or come at the start or end.`));
    }
    // Check for other regex characters that we don't support.
    // Output a warning so the user knows, but otherwise continue normally.
    if (newPath.match(filterPatternCharactersRegex)) {
        logger.warning(getConfigFilePropertyError(configFile, propertyName, `"${originalPath}" contains an unsupported character. ` +
            `The filter pattern characters ?, +, [, ], ! are not supported and will be matched literally.`));
    }
    // Ban any uses of backslash for now.
    // This may not play nicely with project layouts.
    // This restriction can be lifted later if we determine they are ok.
    if (newPath.indexOf("\\") !== -1) {
        throw new Error(getConfigFilePropertyError(configFile, propertyName, `"${originalPath}" contains an "\\" character. These are not allowed in filters. ` +
            `If running on windows we recommend using "/" instead for path filters.`));
    }
    return newPath;
}
exports.validateAndSanitisePath = validateAndSanitisePath;
// An undefined configFile in some of these functions indicates that
// the property was in a workflow file, not a config file
function getNameInvalid(configFile) {
    return getConfigFilePropertyError(configFile, NAME_PROPERTY, "must be a non-empty string");
}
exports.getNameInvalid = getNameInvalid;
function getDisableDefaultQueriesInvalid(configFile) {
    return getConfigFilePropertyError(configFile, DISABLE_DEFAULT_QUERIES_PROPERTY, "must be a boolean");
}
exports.getDisableDefaultQueriesInvalid = getDisableDefaultQueriesInvalid;
function getQueriesInvalid(configFile) {
    return getConfigFilePropertyError(configFile, QUERIES_PROPERTY, "must be an array");
}
exports.getQueriesInvalid = getQueriesInvalid;
function getQueriesMissingUses(configFile) {
    return getConfigFilePropertyError(configFile, QUERIES_PROPERTY, "must be an array, with each entry having a 'uses' property");
}
exports.getQueriesMissingUses = getQueriesMissingUses;
function getQueryUsesInvalid(configFile, queryUses) {
    return getConfigFilePropertyError(configFile, `${QUERIES_PROPERTY}.${QUERIES_USES_PROPERTY}`, `must be a built-in suite (${builtinSuites.join(" or ")}), a relative path, or be of the form "owner/repo[/path]@ref"${queryUses !== undefined ? `\n Found: ${queryUses}` : ""}`);
}
exports.getQueryUsesInvalid = getQueryUsesInvalid;
function getPathsIgnoreInvalid(configFile) {
    return getConfigFilePropertyError(configFile, PATHS_IGNORE_PROPERTY, "must be an array of non-empty strings");
}
exports.getPathsIgnoreInvalid = getPathsIgnoreInvalid;
function getPathsInvalid(configFile) {
    return getConfigFilePropertyError(configFile, PATHS_PROPERTY, "must be an array of non-empty strings");
}
exports.getPathsInvalid = getPathsInvalid;
function getPacksRequireLanguage(lang, configFile) {
    return getConfigFilePropertyError(configFile, PACKS_PROPERTY, `has "${lang}", but it is not a valid language.`);
}
function getPacksInvalidSplit(configFile) {
    return getConfigFilePropertyError(configFile, PACKS_PROPERTY, "must split packages by language");
}
exports.getPacksInvalidSplit = getPacksInvalidSplit;
function getPacksInvalid(configFile) {
    return getConfigFilePropertyError(configFile, PACKS_PROPERTY, "must be an array of non-empty strings");
}
exports.getPacksInvalid = getPacksInvalid;
function getPacksStrInvalid(packStr, configFile) {
    return configFile
        ? getConfigFilePropertyError(configFile, PACKS_PROPERTY, `"${packStr}" is not a valid pack`)
        : `"${packStr}" is not a valid pack`;
}
exports.getPacksStrInvalid = getPacksStrInvalid;
function getLocalPathOutsideOfRepository(configFile, localPath) {
    return getConfigFilePropertyError(configFile, `${QUERIES_PROPERTY}.${QUERIES_USES_PROPERTY}`, `is invalid as the local path "${localPath}" is outside of the repository`);
}
exports.getLocalPathOutsideOfRepository = getLocalPathOutsideOfRepository;
function getLocalPathDoesNotExist(configFile, localPath) {
    return getConfigFilePropertyError(configFile, `${QUERIES_PROPERTY}.${QUERIES_USES_PROPERTY}`, `is invalid as the local path "${localPath}" does not exist in the repository`);
}
exports.getLocalPathDoesNotExist = getLocalPathDoesNotExist;
function getConfigFileOutsideWorkspaceErrorMessage(configFile) {
    return `The configuration file "${configFile}" is outside of the workspace`;
}
exports.getConfigFileOutsideWorkspaceErrorMessage = getConfigFileOutsideWorkspaceErrorMessage;
function getConfigFileDoesNotExistErrorMessage(configFile) {
    return `The configuration file "${configFile}" does not exist`;
}
exports.getConfigFileDoesNotExistErrorMessage = getConfigFileDoesNotExistErrorMessage;
function getConfigFileRepoFormatInvalidMessage(configFile) {
    let error = `The configuration file "${configFile}" is not a supported remote file reference.`;
    error += " Expected format <owner>/<repository>/<file-path>@<ref>";
    return error;
}
exports.getConfigFileRepoFormatInvalidMessage = getConfigFileRepoFormatInvalidMessage;
function getConfigFileFormatInvalidMessage(configFile) {
    return `The configuration file "${configFile}" could not be read`;
}
exports.getConfigFileFormatInvalidMessage = getConfigFileFormatInvalidMessage;
function getConfigFileDirectoryGivenMessage(configFile) {
    return `The configuration file "${configFile}" looks like a directory, not a file`;
}
exports.getConfigFileDirectoryGivenMessage = getConfigFileDirectoryGivenMessage;
function getConfigFilePropertyError(configFile, property, error) {
    if (configFile === undefined) {
        return `The workflow property "${property}" is invalid: ${error}`;
    }
    else {
        return `The configuration file "${configFile}" is invalid: property "${property}" ${error}`;
    }
}
function getNoLanguagesError() {
    return ("Did not detect any languages to analyze. " +
        "Please update input in workflow or check that GitHub detects the correct languages in your repository.");
}
exports.getNoLanguagesError = getNoLanguagesError;
function getUnknownLanguagesError(languages) {
    return `Did not recognise the following languages: ${languages.join(", ")}`;
}
exports.getUnknownLanguagesError = getUnknownLanguagesError;
/**
 * Gets the set of languages in the current repository that are
 * scannable by CodeQL.
 */
async function getLanguagesInRepo(repository, logger) {
    logger.debug(`GitHub repo ${repository.owner} ${repository.repo}`);
    const response = await api.getApiClient().repos.listLanguages({
        owner: repository.owner,
        repo: repository.repo,
    });
    logger.debug(`Languages API response: ${JSON.stringify(response)}`);
    // The GitHub API is going to return languages in order of popularity,
    // When we pick a language to autobuild we want to pick the most popular traced language
    // Since sets in javascript maintain insertion order, using a set here and then splatting it
    // into an array gives us an array of languages ordered by popularity
    const languages = new Set();
    for (const lang of Object.keys(response.data)) {
        const parsedLang = (0, languages_1.parseLanguage)(lang);
        if (parsedLang !== undefined) {
            languages.add(parsedLang);
        }
    }
    return [...languages];
}
exports.getLanguagesInRepo = getLanguagesInRepo;
/**
 * Get the languages to analyse.
 *
 * The result is obtained from the action input parameter 'languages' if that
 * has been set, otherwise it is deduced as all languages in the repo that
 * can be analysed.
 *
 * If no languages could be detected from either the workflow or the repository
 * then throw an error.
 */
async function getLanguages(codeQL, languagesInput, repository, logger) {
    // Obtain languages without filtering them.
    const { rawLanguages, autodetected } = await getRawLanguages(languagesInput, repository, logger);
    let languages = rawLanguages.map(languages_1.resolveAlias);
    if (autodetected) {
        const availableLanguages = await codeQL.resolveLanguages();
        languages = languages.filter((value) => value in availableLanguages);
        logger.info(`Automatically detected languages: ${languages.join(", ")}`);
    }
    else {
        logger.info(`Languages from configuration: ${languages.join(", ")}`);
    }
    // If the languages parameter was not given and no languages were
    // detected then fail here as this is a workflow configuration error.
    if (languages.length === 0) {
        throw new Error(getNoLanguagesError());
    }
    // Make sure they are supported
    const parsedLanguages = [];
    const unknownLanguages = [];
    for (const language of languages) {
        // We know this is not an alias since we resolved it above.
        const parsedLanguage = (0, languages_1.parseLanguage)(language);
        if (parsedLanguage === undefined) {
            unknownLanguages.push(language);
        }
        else if (!parsedLanguages.includes(parsedLanguage)) {
            parsedLanguages.push(parsedLanguage);
        }
    }
    // Any unknown languages here would have come directly from the input
    // since we filter unknown languages coming from the GitHub API.
    if (unknownLanguages.length > 0) {
        throw new Error(getUnknownLanguagesError(unknownLanguages));
    }
    return parsedLanguages;
}
exports.getLanguages = getLanguages;
/**
 * Gets the set of languages in the current repository without checking to
 * see if these languages are actually supported by CodeQL.
 *
 * @param languagesInput The languages from the workflow input
 * @param repository the owner/name of the repository
 * @param logger a logger
 * @returns A tuple containing a list of languages in this repository that might be
 * analyzable and whether or not this list was determined automatically.
 */
async function getRawLanguages(languagesInput, repository, logger) {
    // Obtain from action input 'languages' if set
    let rawLanguages = (languagesInput || "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.length > 0);
    let autodetected;
    if (rawLanguages.length) {
        autodetected = false;
    }
    else {
        autodetected = true;
        // Obtain all languages in the repo that can be analysed
        rawLanguages = (await getLanguagesInRepo(repository, logger));
    }
    return { rawLanguages, autodetected };
}
exports.getRawLanguages = getRawLanguages;
async function addQueriesAndPacksFromWorkflow(codeQL, queriesInput, languages, resultMap, packs, tempDir, workspacePath, apiDetails, features, logger) {
    let injectedMlQueries = false;
    queriesInput = queriesInput.trim();
    // "+" means "don't override config file" - see shouldAddConfigFileQueries
    queriesInput = queriesInput.replace(/^\+/, "");
    for (const query of queriesInput.split(",")) {
        const didInject = await parseQueryUses(languages, codeQL, resultMap, packs, query, tempDir, workspacePath, apiDetails, features, logger);
        injectedMlQueries = injectedMlQueries || didInject;
    }
    return injectedMlQueries;
}
// Returns true if either no queries were provided in the workflow.
// or if the queries in the workflow were provided in "additive" mode,
// indicating that they shouldn't override the config queries but
// should instead be added in addition
function shouldAddConfigFileQueries(queriesInput) {
    if (queriesInput) {
        return queriesInput.trimStart().slice(0, 1) === "+";
    }
    return true;
}
/**
 * Get the default config for when the user has not supplied one.
 */
async function getDefaultConfig(languagesInput, rawQueriesInput, rawPacksInput, rawThreatModelsInput, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger) {
    const languages = await getLanguages(codeQL, languagesInput, repository, logger);
    const queries = {};
    for (const language of languages) {
        queries[language] = {
            builtin: [],
            custom: [],
        };
    }
    await addDefaultQueries(codeQL, languages, queries);
    const augmentationProperties = calculateAugmentation(rawPacksInput, rawQueriesInput, rawThreatModelsInput, languages);
    const packs = augmentationProperties.packsInput
        ? {
            [languages[0]]: augmentationProperties.packsInput,
        }
        : {};
    if (rawQueriesInput) {
        augmentationProperties.injectedMlQueries =
            await addQueriesAndPacksFromWorkflow(codeQL, rawQueriesInput, languages, queries, packs, tempDir, workspacePath, apiDetails, features, logger);
    }
    const { trapCaches, trapCacheDownloadTime } = await downloadCacheWithTime(trapCachingEnabled, codeQL, languages, logger);
    return {
        languages,
        queries,
        pathsIgnore: [],
        paths: [],
        packs,
        originalUserInput: {},
        tempDir,
        codeQLCmd: codeQL.getPath(),
        gitHubVersion,
        dbLocation: dbLocationOrDefault(dbLocation, tempDir),
        debugMode,
        debugArtifactName,
        debugDatabaseName,
        augmentationProperties,
        trapCaches,
        trapCacheDownloadTime,
    };
}
exports.getDefaultConfig = getDefaultConfig;
async function downloadCacheWithTime(trapCachingEnabled, codeQL, languages, logger) {
    let trapCaches = {};
    let trapCacheDownloadTime = 0;
    if (trapCachingEnabled) {
        const start = perf_hooks_1.performance.now();
        trapCaches = await (0, trap_caching_1.downloadTrapCaches)(codeQL, languages, logger);
        trapCacheDownloadTime = perf_hooks_1.performance.now() - start;
    }
    return { trapCaches, trapCacheDownloadTime };
}
/**
 * Load the config from the given file.
 */
async function loadConfig(languagesInput, rawQueriesInput, rawPacksInput, rawThreatModelsInput, configFile, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger) {
    let parsedYAML;
    if (isLocal(configFile)) {
        // Treat the config file as relative to the workspace
        configFile = path.resolve(workspacePath, configFile);
        parsedYAML = getLocalConfig(configFile, workspacePath);
    }
    else {
        parsedYAML = await getRemoteConfig(configFile, apiDetails);
    }
    // Validate that the 'name' property is syntactically correct,
    // even though we don't use the value yet.
    if (NAME_PROPERTY in parsedYAML) {
        if (typeof parsedYAML[NAME_PROPERTY] !== "string") {
            throw new Error(getNameInvalid(configFile));
        }
        if (parsedYAML[NAME_PROPERTY].length === 0) {
            throw new Error(getNameInvalid(configFile));
        }
    }
    const languages = await getLanguages(codeQL, languagesInput, repository, logger);
    const queries = {};
    for (const language of languages) {
        queries[language] = {
            builtin: [],
            custom: [],
        };
    }
    const pathsIgnore = [];
    const paths = [];
    let disableDefaultQueries = false;
    if (DISABLE_DEFAULT_QUERIES_PROPERTY in parsedYAML) {
        if (typeof parsedYAML[DISABLE_DEFAULT_QUERIES_PROPERTY] !== "boolean") {
            throw new Error(getDisableDefaultQueriesInvalid(configFile));
        }
        disableDefaultQueries = parsedYAML[DISABLE_DEFAULT_QUERIES_PROPERTY];
    }
    if (!disableDefaultQueries) {
        await addDefaultQueries(codeQL, languages, queries);
    }
    const augmentationProperties = calculateAugmentation(rawPacksInput, rawQueriesInput, rawThreatModelsInput, languages);
    const packs = parsePacks(parsedYAML[PACKS_PROPERTY] ?? {}, rawPacksInput, augmentationProperties.packsInputCombines, languages, configFile, logger);
    // If queries were provided using `with` in the action configuration,
    // they should take precedence over the queries in the config file
    // unless they're prefixed with "+", in which case they supplement those
    // in the config file.
    if (rawQueriesInput) {
        augmentationProperties.injectedMlQueries =
            await addQueriesAndPacksFromWorkflow(codeQL, rawQueriesInput, languages, queries, packs, tempDir, workspacePath, apiDetails, features, logger);
    }
    if (shouldAddConfigFileQueries(rawQueriesInput) &&
        QUERIES_PROPERTY in parsedYAML) {
        const queriesArr = parsedYAML[QUERIES_PROPERTY];
        if (!Array.isArray(queriesArr)) {
            throw new Error(getQueriesInvalid(configFile));
        }
        for (const query of queriesArr) {
            if (typeof query[QUERIES_USES_PROPERTY] !== "string") {
                throw new Error(getQueriesMissingUses(configFile));
            }
            await parseQueryUses(languages, codeQL, queries, packs, query[QUERIES_USES_PROPERTY], tempDir, workspacePath, apiDetails, features, logger, configFile);
        }
    }
    if (PATHS_IGNORE_PROPERTY in parsedYAML) {
        if (!Array.isArray(parsedYAML[PATHS_IGNORE_PROPERTY])) {
            throw new Error(getPathsIgnoreInvalid(configFile));
        }
        for (const ignorePath of parsedYAML[PATHS_IGNORE_PROPERTY]) {
            if (typeof ignorePath !== "string" || ignorePath === "") {
                throw new Error(getPathsIgnoreInvalid(configFile));
            }
            pathsIgnore.push(validateAndSanitisePath(ignorePath, PATHS_IGNORE_PROPERTY, configFile, logger));
        }
    }
    if (PATHS_PROPERTY in parsedYAML) {
        if (!Array.isArray(parsedYAML[PATHS_PROPERTY])) {
            throw new Error(getPathsInvalid(configFile));
        }
        for (const includePath of parsedYAML[PATHS_PROPERTY]) {
            if (typeof includePath !== "string" || includePath === "") {
                throw new Error(getPathsInvalid(configFile));
            }
            paths.push(validateAndSanitisePath(includePath, PATHS_PROPERTY, configFile, logger));
        }
    }
    const { trapCaches, trapCacheDownloadTime } = await downloadCacheWithTime(trapCachingEnabled, codeQL, languages, logger);
    return {
        languages,
        queries,
        pathsIgnore,
        paths,
        packs,
        originalUserInput: parsedYAML,
        tempDir,
        codeQLCmd: codeQL.getPath(),
        gitHubVersion,
        dbLocation: dbLocationOrDefault(dbLocation, tempDir),
        debugMode,
        debugArtifactName,
        debugDatabaseName,
        augmentationProperties,
        trapCaches,
        trapCacheDownloadTime,
    };
}
/**
 * Calculates how the codeql config file needs to be augmented before passing
 * it to the CLI. The reason this is necessary is the codeql-action can be called
 * with extra inputs from the workflow. These inputs are not part of the config
 * and the CLI does not know about these inputs so we need to inject them into
 * the config file sent to the CLI.
 *
 * @param rawPacksInput The packs input from the action configuration.
 * @param rawQueriesInput The queries input from the action configuration.
 * @param languages The languages that the config file is for. If the packs input
 *    is non-empty, then there must be exactly one language. Otherwise, an
 *    error is thrown.
 *
 * @returns The properties that need to be augmented in the config file.
 *
 * @throws An error if the packs input is non-empty and the languages input does
 *     not have exactly one language.
 */
// exported for testing.
function calculateAugmentation(rawPacksInput, rawQueriesInput, rawThreatModelsInput, languages) {
    const packsInputCombines = shouldCombine(rawPacksInput);
    const packsInput = parsePacksFromInput(rawPacksInput, languages, packsInputCombines);
    const queriesInputCombines = shouldCombine(rawQueriesInput);
    const queriesInput = parseQueriesFromInput(rawQueriesInput, queriesInputCombines);
    const threatModelsInputCombines = shouldCombine(rawThreatModelsInput);
    const threatModelsInput = parseThreatModelsFromInput(rawThreatModelsInput, threatModelsInputCombines);
    return {
        injectedMlQueries: false,
        packsInputCombines,
        packsInput: packsInput?.[languages[0]],
        queriesInput,
        queriesInputCombines,
        threatModelsInputCombines,
        threatModelsInput,
    };
}
exports.calculateAugmentation = calculateAugmentation;
function parseQueriesFromInput(rawQueriesInput, queriesInputCombines) {
    if (!rawQueriesInput) {
        return undefined;
    }
    const trimmedInput = queriesInputCombines
        ? rawQueriesInput.trim().slice(1).trim()
        : rawQueriesInput?.trim() ?? "";
    if (queriesInputCombines && trimmedInput.length === 0) {
        throw new Error(getConfigFilePropertyError(undefined, "queries", "A '+' was used in the 'queries' input to specify that you wished to add some packs to your CodeQL analysis. However, no packs were specified. Please either remove the '+' or specify some packs."));
    }
    return trimmedInput.split(",").map((query) => ({ uses: query.trim() }));
}
/**
 * Pack names must be in the form of `scope/name`, with only alpha-numeric characters,
 * and `-` allowed as long as not the first or last char.
 **/
const PACK_IDENTIFIER_PATTERN = (function () {
    const alphaNumeric = "[a-z0-9]";
    const alphaNumericDash = "[a-z0-9-]";
    const component = `${alphaNumeric}(${alphaNumericDash}*${alphaNumeric})?`;
    return new RegExp(`^${component}/${component}$`);
})();
// Exported for testing
function parsePacksFromConfig(packsByLanguage, languages, configFile, logger) {
    const packs = {};
    if (Array.isArray(packsByLanguage)) {
        if (languages.length === 1) {
            // single language analysis, so language is implicit
            packsByLanguage = {
                [languages[0]]: packsByLanguage,
            };
        }
        else {
            // this is an error since multi-language analysis requires
            // packs split by language
            throw new Error(getPacksInvalidSplit(configFile));
        }
    }
    for (const [lang, packsArr] of Object.entries(packsByLanguage)) {
        if (!Array.isArray(packsArr)) {
            throw new Error(getPacksInvalid(configFile));
        }
        if (!languages.includes(lang)) {
            // This particular language is not being analyzed in this run.
            if (languages_1.Language[lang]) {
                logger.info(`Ignoring packs for ${lang} since this language is not being analyzed in this run.`);
                continue;
            }
            else {
                // This language is invalid, probably a misspelling
                throw new Error(getPacksRequireLanguage(configFile, lang));
            }
        }
        packs[lang] = packsArr.map((packStr) => validatePackSpecification(packStr, configFile));
    }
    return packs;
}
exports.parsePacksFromConfig = parsePacksFromConfig;
function parsePacksFromInput(rawPacksInput, languages, packsInputCombines) {
    if (!rawPacksInput?.trim()) {
        return undefined;
    }
    if (languages.length > 1) {
        throw new Error("Cannot specify a 'packs' input in a multi-language analysis. Use a codeql-config.yml file instead and specify packs by language.");
    }
    else if (languages.length === 0) {
        throw new Error("No languages specified. Cannot process the packs input.");
    }
    rawPacksInput = rawPacksInput.trim();
    if (packsInputCombines) {
        rawPacksInput = rawPacksInput.trim().substring(1).trim();
        if (!rawPacksInput) {
            throw new Error(getConfigFilePropertyError(undefined, "packs", "A '+' was used in the 'packs' input to specify that you wished to add some packs to your CodeQL analysis. However, no packs were specified. Please either remove the '+' or specify some packs."));
        }
    }
    return {
        [languages[0]]: rawPacksInput.split(",").reduce((packs, pack) => {
            packs.push(validatePackSpecification(pack, ""));
            return packs;
        }, []),
    };
}
function parseThreatModelsFromInput(rawThreatModelsInput, threatModelsInputCombines) {
    if (!rawThreatModelsInput?.trim()) {
        return undefined;
    }
    rawThreatModelsInput = rawThreatModelsInput.trim();
    if (threatModelsInputCombines) {
        rawThreatModelsInput = rawThreatModelsInput.trim().substring(1).trim();
        if (!rawThreatModelsInput) {
            throw new Error(getConfigFilePropertyError(undefined, "threat-models", "A '+' was used in the 'threat-models' input to specify that you wished to add some packs to your CodeQL analysis. However, no threat models were specified. Please either remove the '+' or specify some threat models."));
        }
    }
    return rawThreatModelsInput.split(",").map((t) => t.trim());
}
/**
 * Validates that this package specification is syntactically correct.
 * It may not point to any real package, but after this function returns
 * without throwing, we are guaranteed that the package specification
 * is roughly correct.
 *
 * The CLI itself will do a more thorough validation of the package
 * specification.
 *
 * A package specification looks like this:
 *
 * `scope/name@version:path`
 *
 * Version and path are optional.
 *
 * @param packStr the package specification to verify.
 * @param configFile Config file to use for error reporting
 */
function parsePacksSpecification(packStr, configFile) {
    if (typeof packStr !== "string") {
        throw new Error(getPacksStrInvalid(packStr, configFile));
    }
    packStr = packStr.trim();
    const atIndex = packStr.indexOf("@");
    const colonIndex = packStr.indexOf(":", atIndex);
    const packStart = 0;
    const versionStart = atIndex + 1 || undefined;
    const pathStart = colonIndex + 1 || undefined;
    const packEnd = Math.min(atIndex > 0 ? atIndex : Infinity, colonIndex > 0 ? colonIndex : Infinity, packStr.length);
    const versionEnd = versionStart
        ? Math.min(colonIndex > 0 ? colonIndex : Infinity, packStr.length)
        : undefined;
    const pathEnd = pathStart ? packStr.length : undefined;
    const packName = packStr.slice(packStart, packEnd).trim();
    const version = versionStart
        ? packStr.slice(versionStart, versionEnd).trim()
        : undefined;
    const packPath = pathStart
        ? packStr.slice(pathStart, pathEnd).trim()
        : undefined;
    if (!PACK_IDENTIFIER_PATTERN.test(packName)) {
        throw new Error(getPacksStrInvalid(packStr, configFile));
    }
    if (version) {
        try {
            new semver.Range(version);
        }
        catch (e) {
            // The range string is invalid. OK to ignore the caught error
            throw new Error(getPacksStrInvalid(packStr, configFile));
        }
    }
    if (packPath &&
        (path.isAbsolute(packPath) ||
            // Permit using "/" instead of "\" on Windows
            // Use `x.split(y).join(z)` as a polyfill for `x.replaceAll(y, z)` since
            // if we used a regex we'd need to escape the path separator on Windows
            // which seems more awkward.
            path.normalize(packPath).split(path.sep).join("/") !==
                packPath.split(path.sep).join("/"))) {
        throw new Error(getPacksStrInvalid(packStr, configFile));
    }
    if (!packPath && pathStart) {
        // 0 length path
        throw new Error(getPacksStrInvalid(packStr, configFile));
    }
    return {
        name: packName,
        version,
        path: packPath,
    };
}
exports.parsePacksSpecification = parsePacksSpecification;
function prettyPrintPack(pack) {
    return `${pack.name}${pack.version ? `@${pack.version}` : ""}${pack.path ? `:${pack.path}` : ""}`;
}
exports.prettyPrintPack = prettyPrintPack;
function validatePackSpecification(pack, configFile) {
    return prettyPrintPack(parsePacksSpecification(pack, configFile));
}
exports.validatePackSpecification = validatePackSpecification;
// exported for testing
function parsePacks(rawPacksFromConfig, rawPacksFromInput, packsInputCombines, languages, configFile, logger) {
    const packsFomConfig = parsePacksFromConfig(rawPacksFromConfig, languages, configFile, logger);
    const packsFromInput = parsePacksFromInput(rawPacksFromInput, languages, packsInputCombines);
    if (!packsFromInput) {
        return packsFomConfig;
    }
    if (!packsInputCombines) {
        if (!packsFromInput) {
            throw new Error(getPacksInvalid(configFile));
        }
        return packsFromInput;
    }
    return combinePacks(packsFromInput, packsFomConfig);
}
exports.parsePacks = parsePacks;
/**
 * The convention in this action is that an input value that is prefixed with a '+' will
 * be combined with the corresponding value in the config file.
 *
 * Without a '+', an input value will override the corresponding value in the config file.
 *
 * @param inputValue The input value to process.
 * @returns true if the input value should replace the corresponding value in the config file,
 *          false if it should be appended.
 */
function shouldCombine(inputValue) {
    return !!inputValue?.trim().startsWith("+");
}
function combinePacks(packs1, packs2) {
    const packs = {};
    for (const lang of Object.keys(packs1)) {
        packs[lang] = packs1[lang].concat(packs2[lang] || []);
    }
    for (const lang of Object.keys(packs2)) {
        if (!packs[lang]) {
            packs[lang] = packs2[lang];
        }
    }
    return packs;
}
function dbLocationOrDefault(dbLocation, tempDir) {
    return dbLocation || path.resolve(tempDir, "codeql_databases");
}
/**
 * Load and return the config.
 *
 * This will parse the config from the user input if present, or generate
 * a default config. The parsed config is then stored to a known location.
 */
async function initConfig(languagesInput, queriesInput, packsInput, threatModelsInput, registriesInput, configFile, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger) {
    let config;
    // If no config file was provided create an empty one
    if (!configFile) {
        logger.debug("No configuration file was provided");
        config = await getDefaultConfig(languagesInput, queriesInput, packsInput, threatModelsInput, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger);
    }
    else {
        config = await loadConfig(languagesInput, queriesInput, packsInput, threatModelsInput, configFile, dbLocation, trapCachingEnabled, debugMode, debugArtifactName, debugDatabaseName, repository, tempDir, codeQL, workspacePath, gitHubVersion, apiDetails, features, logger);
    }
    // When using the codescanning config in the CLI, pack downloads
    // happen in the CLI during the `database init` command, so no need
    // to download them here.
    await (0, util_1.logCodeScanningConfigInCli)(codeQL, features, logger);
    if (!(await (0, util_1.useCodeScanningConfigInCli)(codeQL, features))) {
        // The list of queries should not be empty for any language. If it is then
        // it is a user configuration error.
        // This check occurs in the CLI when it parses the config file.
        for (const language of config.languages) {
            const hasBuiltinQueries = config.queries[language]?.builtin.length > 0;
            const hasCustomQueries = config.queries[language]?.custom.length > 0;
            const hasPacks = (config.packs[language]?.length || 0) > 0;
            if (!hasPacks && !hasBuiltinQueries && !hasCustomQueries) {
                throw new Error(`Did not detect any queries to run for ${language}. ` +
                    "Please make sure that the default queries are enabled, or you are specifying queries to run.");
            }
        }
        await downloadPacks(codeQL, config.languages, config.packs, apiDetails, registriesInput, config.tempDir, logger);
    }
    // Save the config so we can easily access it again in the future
    await saveConfig(config, logger);
    return config;
}
exports.initConfig = initConfig;
function parseRegistries(registriesInput) {
    try {
        return registriesInput
            ? yaml.load(registriesInput)
            : undefined;
    }
    catch (e) {
        throw new Error("Invalid registries input. Must be a YAML string.");
    }
}
function isLocal(configPath) {
    // If the path starts with ./, look locally
    if (configPath.indexOf("./") === 0) {
        return true;
    }
    return configPath.indexOf("@") === -1;
}
function getLocalConfig(configFile, workspacePath) {
    // Error if the config file is now outside of the workspace
    if (!(configFile + path.sep).startsWith(workspacePath + path.sep)) {
        throw new Error(getConfigFileOutsideWorkspaceErrorMessage(configFile));
    }
    // Error if the file does not exist
    if (!fs.existsSync(configFile)) {
        throw new Error(getConfigFileDoesNotExistErrorMessage(configFile));
    }
    return yaml.load(fs.readFileSync(configFile, "utf8"));
}
async function getRemoteConfig(configFile, apiDetails) {
    // retrieve the various parts of the config location, and ensure they're present
    const format = new RegExp("(?<owner>[^/]+)/(?<repo>[^/]+)/(?<path>[^@]+)@(?<ref>.*)");
    const pieces = format.exec(configFile);
    // 5 = 4 groups + the whole expression
    if (pieces === null || pieces.groups === undefined || pieces.length < 5) {
        throw new Error(getConfigFileRepoFormatInvalidMessage(configFile));
    }
    const response = await api
        .getApiClientWithExternalAuth(apiDetails)
        .repos.getContent({
        owner: pieces.groups.owner,
        repo: pieces.groups.repo,
        path: pieces.groups.path,
        ref: pieces.groups.ref,
    });
    let fileContents;
    if ("content" in response.data && response.data.content !== undefined) {
        fileContents = response.data.content;
    }
    else if (Array.isArray(response.data)) {
        throw new Error(getConfigFileDirectoryGivenMessage(configFile));
    }
    else {
        throw new Error(getConfigFileFormatInvalidMessage(configFile));
    }
    return yaml.load(Buffer.from(fileContents, "base64").toString("binary"));
}
/**
 * Get the file path where the parsed config will be stored.
 */
function getPathToParsedConfigFile(tempDir) {
    return path.join(tempDir, "config");
}
exports.getPathToParsedConfigFile = getPathToParsedConfigFile;
/**
 * Store the given config to the path returned from getPathToParsedConfigFile.
 */
async function saveConfig(config, logger) {
    const configString = JSON.stringify(config);
    const configFile = getPathToParsedConfigFile(config.tempDir);
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, configString, "utf8");
    logger.debug("Saved config:");
    logger.debug(configString);
}
/**
 * Get the config that has been saved to the given temp dir.
 * If the config could not be found then returns undefined.
 */
async function getConfig(tempDir, logger) {
    const configFile = getPathToParsedConfigFile(tempDir);
    if (!fs.existsSync(configFile)) {
        return undefined;
    }
    const configString = fs.readFileSync(configFile, "utf8");
    logger.debug("Loaded config:");
    logger.debug(configString);
    return JSON.parse(configString);
}
exports.getConfig = getConfig;
async function downloadPacks(codeQL, languages, packs, apiDetails, registriesInput, tempDir, logger) {
    // This code path is only used when config parsing occurs in the Action.
    const { registriesAuthTokens, qlconfigFile } = await generateRegistries(registriesInput, codeQL, tempDir, logger);
    await wrapEnvironment({
        GITHUB_TOKEN: apiDetails.auth,
        CODEQL_REGISTRIES_AUTH: registriesAuthTokens,
    }, async () => {
        let numPacksDownloaded = 0;
        logger.startGroup("Downloading packs");
        for (const language of languages) {
            const packsWithVersion = packs[language];
            if (packsWithVersion?.length) {
                logger.info(`Downloading custom packs for ${language}`);
                const results = await codeQL.packDownload(packsWithVersion, qlconfigFile);
                numPacksDownloaded += results.packs.length;
                logger.info(`Downloaded: ${results.packs
                    .map((r) => `${r.name}@${r.version || "latest"}`)
                    .join(", ")}`);
            }
        }
        if (numPacksDownloaded > 0) {
            logger.info(`Downloaded ${numPacksDownloaded} ${numPacksDownloaded === 1 ? "pack" : "packs"}`);
        }
        else {
            logger.info("No packs to download");
        }
        logger.endGroup();
    });
}
exports.downloadPacks = downloadPacks;
/**
 * Generate a `qlconfig.yml` file from the `registries` input.
 * This file is used by the CodeQL CLI to list the registries to use for each
 * pack.
 *
 * @param registriesInput The value of the `registries` input.
 * @param codeQL a codeQL object, used only for checking the version of CodeQL.
 * @param tempDir a temporary directory to store the generated qlconfig.yml file.
 * @param logger a logger object.
 * @returns The path to the generated `qlconfig.yml` file and the auth tokens to
 *        use for each registry.
 */
async function generateRegistries(registriesInput, codeQL, tempDir, logger) {
    const registries = parseRegistries(registriesInput);
    let registriesAuthTokens;
    let qlconfigFile;
    if (registries) {
        if (!(await (0, util_1.codeQlVersionAbove)(codeQL, codeql_1.CODEQL_VERSION_GHES_PACK_DOWNLOAD))) {
            throw new Error(`The 'registries' input is not supported on CodeQL CLI versions earlier than ${codeql_1.CODEQL_VERSION_GHES_PACK_DOWNLOAD}. Please upgrade to CodeQL CLI version ${codeql_1.CODEQL_VERSION_GHES_PACK_DOWNLOAD} or later.`);
        }
        // generate a qlconfig.yml file to hold the registry configs.
        const qlconfig = createRegistriesBlock(registries);
        qlconfigFile = path.join(tempDir, "qlconfig.yml");
        const qlconfigContents = yaml.dump(qlconfig);
        fs.writeFileSync(qlconfigFile, qlconfigContents, "utf8");
        logger.debug("Generated qlconfig.yml:");
        logger.debug(qlconfigContents);
        registriesAuthTokens = registries
            .map((registry) => `${registry.url}=${registry.token}`)
            .join(",");
    }
    if (typeof process.env.CODEQL_REGISTRIES_AUTH === "string") {
        logger.debug("Using CODEQL_REGISTRIES_AUTH environment variable to authenticate with registries.");
    }
    return {
        registriesAuthTokens: 
        // if the user has explicitly set the CODEQL_REGISTRIES_AUTH env var then use that
        process.env.CODEQL_REGISTRIES_AUTH ?? registriesAuthTokens,
        qlconfigFile,
    };
}
exports.generateRegistries = generateRegistries;
function createRegistriesBlock(registries) {
    if (!Array.isArray(registries) ||
        registries.some((r) => !r.url || !r.packages)) {
        throw new Error("Invalid 'registries' input. Must be an array of objects with 'url' and 'packages' properties.");
    }
    // be sure to remove the `token` field from the registry before writing it to disk.
    const safeRegistries = registries.map((registry) => ({
        // ensure the url ends with a slash to avoid a bug in the CLI 2.10.4
        url: !registry?.url.endsWith("/") ? `${registry.url}/` : registry.url,
        packages: registry.packages,
    }));
    const qlconfig = {
        registries: safeRegistries,
    };
    return qlconfig;
}
/**
 * Create a temporary environment based on the existing environment and overridden
 * by the given environment variables that are passed in as arguments.
 *
 * Use this new environment in the context of the given operation. After completing
 * the operation, restore the original environment.
 *
 * This function does not support un-setting environment variables.
 *
 * @param env
 * @param operation
 */
async function wrapEnvironment(env, operation) {
    // Remember the original env
    const oldEnv = { ...process.env };
    // Set the new env
    for (const [key, value] of Object.entries(env)) {
        // Ignore undefined keys
        if (value !== undefined) {
            process.env[key] = value;
        }
    }
    try {
        // Run the operation
        await operation();
    }
    finally {
        // Restore the old env
        for (const [key, value] of Object.entries(oldEnv)) {
            process.env[key] = value;
        }
    }
}
exports.wrapEnvironment = wrapEnvironment;
/**
 * Get the path to the code scanning configuration generated by the CLI.
 *
 * This will not exist if the configuration is being parsed in the Action.
 */
function getGeneratedCodeScanningConfigPath(config) {
    return path.resolve(config.tempDir, "user-config.yaml");
}
exports.getGeneratedCodeScanningConfigPath = getGeneratedCodeScanningConfigPath;
//# sourceMappingURL=config-utils.js.map