/// <reference path="sys.ts" />
/// <reference path="emitter.ts" />
/// <reference path="core.ts" />

namespace ts {
    /* @internal */ export let programTime = 0;
    /* @internal */ export let emitTime = 0;
    /* @internal */ export let ioReadTime = 0;
    /* @internal */ export let ioWriteTime = 0;

    /** The version of the TypeScript compiler release */

    const emptyArray: any[] = [];

    export const version = "1.8.0";

    export function findConfigFile(searchPath: string): string {
        let fileName = "tsconfig.json";
        while (true) {
            if (sys.fileExists(fileName)) {
                return fileName;
            }
            const parentPath = getDirectoryPath(searchPath);
            if (parentPath === searchPath) {
                break;
            }
            searchPath = parentPath;
            fileName = "../" + fileName;
        }
        return undefined;
    }

    export function resolveTripleslashReference(moduleName: string, containingFile: string): string {
        const basePath = getDirectoryPath(containingFile);
        const referencedFileName = isRootedDiskPath(moduleName) ? moduleName : combinePaths(basePath, moduleName);
        return normalizePath(referencedFileName);
    }

    export function resolveModuleName(moduleName: string, containingFile: string, compilerOptions: CompilerOptions, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {
        let moduleResolution = compilerOptions.moduleResolution;
        if (moduleResolution === undefined) {
            if (compilerOptions.module === ModuleKind.CommonJS) {
                moduleResolution = ModuleResolutionKind.NodeJs;
            }
            else if (compilerOptions.baseUrl !== undefined || compilerOptions.paths || compilerOptions.rootDirs) {
                moduleResolution = ModuleResolutionKind.BaseUrl;
            }
            else {
                moduleResolution = ModuleResolutionKind.Classic;
            }
        }

        switch (moduleResolution) {
            case ModuleResolutionKind.NodeJs: return nodeModuleNameResolver(moduleName, containingFile, host);
            case ModuleResolutionKind.Classic: return classicNameResolver(moduleName, containingFile, compilerOptions, host);
            case ModuleResolutionKind.BaseUrl: return baseUrlModuleNameResolver(moduleName, containingFile, compilerOptions, host);
        }
    }

    // Path mapping based module resolution strategy uses base url to resolve relative file names. This resolution strategy can be enabled 
    // by setting 'moduleResolution' option to 'baseUrl' and as it implied by the name it uses base url to resolve module names.
    // Base url can be specified:
    //   - explicitly via command line option 'baseUrl'. If this value is relative it will be computed relative to current directory.
    //   - explicitly in 'tsconfig.json' via 'baseUrl' compiler option. If this value is relative it will be computed relative to the location 
    //     of 'tsconfig.json'.
    //   - if value is not provided explicitly but project uses tsconfig.json then 'baseUrl' will be set of folder that contains 'tsconfig.json'
    // If baseUrl is the only provided option then non-relative module names will be resolved relative to baseUrl. Relative module names
    // will still be resolved relative to the folder that contains file with import.
    // User can specify additional options in tsconfig.json to tweak module resolution.
    // - 'paths' option allows to tune how non-relative module names will be resolved based on the content of the module name. 
    // Structure of 'paths' compiler options
    // 'paths': {
    //    pattern-1: list of substitutions 1,
    //    pattern-2: list of substitutions 2,
    //    ...
    //    pattern-n: list of substitutions-n
    // }
    // Pattern here is a string that can contain zero or one '*' character. During module resolution module name will be matched against 
    // all patterns in the list. Matching for patterns that don't contain '*' means that module name must be equal to pattern respecting the case.
    // If pattern contains '*' then to match pattern "<prefix>*<suffix>" module name must start with the <prefix> and end with <suffix>. 
    // <MatchedStar> denotes part of the module name between <prefix> and <suffix>. 
    // If module name can be matches with multiple patterns then pattern with the longest prefix will be picked.
    // After selecting pattern we'll use list of substitutions to get candidate locations of the module and the try to load module from the candidate location. 
    // Substitiution is a string that can contain zero or one '*'. To get candidate location from substitution we'll pick every substitution in the list 
    // and replace '*' with <MatchedStar> string. If candidate location is not rooted it  will be converted to absolute using baseUrl.
    // For example:
    // baseUrl: /a/b/c
    // "paths": {
    //     // match all module names
    //     "*": [ 
    //         "*",        // use matched name as is,
    //                     // <matched name> will be looked as /a/b/c/<matched name>
    //
    //         "folder1/*" // substitution will convert matched name to 'folder1/<matched name>',
    //                     // since it is not rooted then final candidate location will be /a/b/c/folder1/<matched name> 
    //     ],
    //     // match module names that start with 'components/'
    //     "components/*": [ "/root/components/*" ] // substitution will convert /components/folder1/<matched name> to '/root/components/folder1/<matched name>',
    //                                              // it is rooted so it will be final candidate location
    // }
    // 'paths' allows to remap locations of non-relative module names. Relative module names usually are resolved relative to the folder
    // that contains import. However sometimes it might  be useful to apply mappings to relative module names as well.
    // Since the there might be different relative file names that refer to the same file we need to convert relative module name to non-relative 
    // so we can just apply path mapping to it. This conversion can be performed using 'rootDirs' compiler option - this options stores list of root directories
    // for the project (if root directory is not absolute it will be converted to absolute using baseUrl as a base path).
    // First - we convert relative module name to absolute using location of file that contains import. 
    // Then we try to find what element is rootDirs is the longest prefix for this absolute file name (respecting case):
    //      <absoluteFileName> = <longestRootDir><suffix> 
    // Once it is done - value of <suffix> is a be non-relative name for initially relative module name.
    // Note that if element in rootDirs should always end with '/' so it will be appended automatically if value in configuration does not have it. 
    // For example:
    // baseUrl: /a/b/c
    // "paths": {
    //     "*": [ "*", "generated/*" ] // try to resolve module name as '/a/b/c/<name>' then look it in '/a/b/c/generated/<name>'
    // }
    // "rootDirs": [
    //     "./src",      // root dir is project baseUrl/src
    //     "./generated" // root dir is baseUrl/generated
    //     "/e/f"        // root dir is /e/f 
    // ]
    // @file: /a/b/c/src/form1.ts
    //     import {x} from "./form.content.ts"
    // @file: /a/b/c/generated/form1.content.ts
    //     export var x = ...
    // first './form.content.ts' needs to be converted to non-relative name.
    // 1. convert it to absolute name '/a/b/c/src/form1.content.ts' ->
    //    find longest prefix in rootDirs that match this path, it will be './src' (after expansion '/a/b/c/src/') ->
    //    suffix is form1.content.ts
    // 2. apply path mappings to 'form1.content.ts' ->
    //    '*' pattern will be matched ->
    //    '*' substitution yields '/a/b/c/form1.content.ts' - file does not exists
    //    'generated/*' substitution yields '/a/b/c/generated/form1.content' - file exists - OK
    export function baseUrlModuleNameResolver(moduleName: string, containingFile: string, options: CompilerOptions, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {
        const baseUrl = options.baseUrl !== undefined ? options.baseUrl : options.inferredBaseUrl;
        Debug.assert(baseUrl !== undefined);

        if (isRootedDiskPath(moduleName)) {
            return { resolvedModule: { resolvedFileName: moduleName }, failedLookupLocations: emptyArray };
        }

        if (nameStartsWithDotSlashOrDotDotSlash(moduleName)) {
            // relative name
            return baseUrlResolveRelativeModuleName(moduleName, containingFile, baseUrl, options, host);
        }
        else {
            // non-relative name
            return baseUrlResolveNonRelativeModuleName(moduleName, baseUrl, options, host);
        }
    }

    export function baseUrlResolveRelativeModuleName(moduleName: string, containingFile: string, baseUrl: string, options: CompilerOptions, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {
        const failedLookupLocations: string[] = [];

        const containingDirectory = getDirectoryPath(containingFile);
        const candidate = normalizePath(combinePaths(containingDirectory, moduleName));

        if (options.rootDirs) {
            const normalizedRootDirs = map(options.rootDirs, r => {
                const normalizedRoot = getNormalizedAbsolutePath(r, baseUrl);
                return endsWith(normalizedRoot, directorySeparator) ? normalizedRoot : normalizedRoot + directorySeparator;
            });

            let matchedRoot: string;
            for (const root of normalizedRootDirs) {
                if (startsWith(candidate, root)) {
                    if (!matchedRoot || matchedRoot.length < root.length) {
                        matchedRoot = root;
                    }
                }
            }
            if (matchedRoot) {
                const suffix = candidate.substr(matchedRoot.length);
                return baseUrlResolveNonRelativeModuleName(suffix, baseUrl, options, host);
            }
            return { resolvedModule: undefined, failedLookupLocations };
        }
        else {
            const resolvedFileName = loadModuleFromFile(supportedExtensions, candidate, failedLookupLocations, host);
            return {
                resolvedModule: resolvedFileName ? { resolvedFileName } : undefined,
                failedLookupLocations
            };
        }
    }

    export function baseUrlResolveNonRelativeModuleName(moduleName: string, baseUrl: string, options: CompilerOptions, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {
        let longestMatchPrefixLength = -1;
        let matchedPattern: string;
        let matchedStar: string;

        const failedLookupLocations: string[] = [];
        if (options.paths) {
            for (const key in options.paths) {
                const pattern: string = key;
                const indexOfStar = pattern.indexOf("*");
                if (indexOfStar !== -1) {
                    const prefix = pattern.substr(0, indexOfStar);
                    const suffix = pattern.substr(indexOfStar + 1);
                    if (moduleName.length >= prefix.length + suffix.length &&
                        startsWith(moduleName, prefix) &&
                        endsWith(moduleName, suffix)) {

                        // use length of prefix as betterness criteria
                        if (prefix.length > longestMatchPrefixLength) {
                            longestMatchPrefixLength = prefix.length;
                            matchedPattern = pattern;
                            matchedStar = moduleName.substr(prefix.length, moduleName.length - suffix.length);
                        }
                    }
                }
                else if (pattern === moduleName) {
                    // pattern was matched as is - no need to seatch further
                    matchedPattern = pattern;
                    matchedStar = undefined;
                    break;
                }
            }
        }

        if (matchedPattern) {
            for (const subst of options.paths[matchedPattern]) {
                const path = matchedStar ? subst.replace("\*", matchedStar) : subst;
                const candidate = normalizePath(combinePaths(baseUrl, path));
                const resolvedFileName = loadModuleFromFile(supportedExtensions, candidate, failedLookupLocations, host);
                if (resolvedFileName) {
                    return { resolvedModule: { resolvedFileName }, failedLookupLocations };
                }
            }

            return { resolvedModule: undefined, failedLookupLocations };
        }
        else {
            const candidate = normalizePath(combinePaths(baseUrl, moduleName));
            const resolvedFileName = loadModuleFromFile(supportedExtensions, candidate, failedLookupLocations, host);
            return {
                resolvedModule: resolvedFileName ? { resolvedFileName } : undefined,
                failedLookupLocations
            };
        }
    }

    function startsWith(str: string, prefix: string): boolean {
        return str.lastIndexOf(prefix, 0) === 0;
    }

    function endsWith(str: string, suffix: string): boolean {
        const expectedPos = str.length - suffix.length;
        return str.indexOf(suffix, expectedPos) === expectedPos;
    }

    export function nodeModuleNameResolver(moduleName: string, containingFile: string, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {
        const containingDirectory = getDirectoryPath(containingFile);

        if (isRootedDiskPath(moduleName) || nameStartsWithDotSlashOrDotDotSlash(moduleName)) {
            const failedLookupLocations: string[] = [];
            const candidate = normalizePath(combinePaths(containingDirectory, moduleName));
            let resolvedFileName = loadModuleFromFile(supportedJsExtensions, candidate, failedLookupLocations, host);

            if (resolvedFileName) {
                return { resolvedModule: { resolvedFileName }, failedLookupLocations };
            }

            resolvedFileName = loadNodeModuleFromDirectory(supportedJsExtensions, candidate, failedLookupLocations, host);
            return resolvedFileName
                ? { resolvedModule: { resolvedFileName }, failedLookupLocations }
                : { resolvedModule: undefined, failedLookupLocations };
        }
        else {
            return loadModuleFromNodeModules(moduleName, containingDirectory, host);
        }
    }

    function loadModuleFromFile(extensions: string[], candidate: string, failedLookupLocation: string[], host: ModuleResolutionHost): string {
        return forEach(extensions, tryLoad);

        function tryLoad(ext: string): string {
            const fileName = fileExtensionIs(candidate, ext) ? candidate : candidate + ext;
            if (host.fileExists(fileName)) {
                return fileName;
            }
            else {
                failedLookupLocation.push(fileName);
                return undefined;
            }
        }
    }

    function loadNodeModuleFromDirectory(extensions: string[], candidate: string, failedLookupLocation: string[], host: ModuleResolutionHost): string {
        const packageJsonPath = combinePaths(candidate, "package.json");
        if (host.fileExists(packageJsonPath)) {

            let jsonContent: { typings?: string };

            try {
                const jsonText = host.readFile(packageJsonPath);
                jsonContent = jsonText ? <{ typings?: string }>JSON.parse(jsonText) : { typings: undefined };
            }
            catch (e) {
                // gracefully handle if readFile fails or returns not JSON 
                jsonContent = { typings: undefined };
            }

            if (jsonContent.typings) {
                const result = loadModuleFromFile(extensions, normalizePath(combinePaths(candidate, jsonContent.typings)), failedLookupLocation, host);
                if (result) {
                    return result;
                }
            }
        }
        else {
            // record package json as one of failed lookup locations - in the future if this file will appear it will invalidate resolution results
            failedLookupLocation.push(packageJsonPath);
        }

        return loadModuleFromFile(extensions, combinePaths(candidate, "index"), failedLookupLocation, host);
    }

    function loadModuleFromNodeModules(moduleName: string, directory: string, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {
        const failedLookupLocations: string[] = [];
        directory = normalizeSlashes(directory);
        while (true) {
            const baseName = getBaseFileName(directory);
            if (baseName !== "node_modules") {
                const nodeModulesFolder = combinePaths(directory, "node_modules");
                const candidate = normalizePath(combinePaths(nodeModulesFolder, moduleName));
                let result = loadModuleFromFile(supportedExtensions, candidate, failedLookupLocations, host);
                if (result) {
                    return { resolvedModule: { resolvedFileName: result, isExternalLibraryImport: true }, failedLookupLocations };
                }

                result = loadNodeModuleFromDirectory(supportedExtensions, candidate, failedLookupLocations, host);
                if (result) {
                    return { resolvedModule: { resolvedFileName: result, isExternalLibraryImport: true }, failedLookupLocations };
                }
            }

            const parentPath = getDirectoryPath(directory);
            if (parentPath === directory) {
                break;
            }

            directory = parentPath;
        }

        return { resolvedModule: undefined, failedLookupLocations };
    }

    function nameStartsWithDotSlashOrDotDotSlash(name: string) {
        const i = name.lastIndexOf("./", 1);
        return i === 0 || (i === 1 && name.charCodeAt(0) === CharacterCodes.dot);
    }

    function getNumberOfChars(str: string, ch: CharacterCodes): number {
        let n = 0;
        for (let i = 0; i < str.length; ++i) {
            if (str.charCodeAt(i) === ch) {
                n++;
            }
        }
        return n;
    }

    export function classicNameResolver(moduleName: string, containingFile: string, compilerOptions: CompilerOptions, host: ModuleResolutionHost): ResolvedModuleWithFailedLookupLocations {

        // module names that contain '!' are used to reference resources and are not resolved to actual files on disk
        if (moduleName.indexOf("!") != -1) {
            return { resolvedModule: undefined, failedLookupLocations: [] };
        }

        let searchPath = getDirectoryPath(containingFile);
        let searchName: string;

        const failedLookupLocations: string[] = [];

        let referencedSourceFile: string;
        const extensions = compilerOptions.allowNonTsExtensions ? supportedJsExtensions : supportedExtensions;
        while (true) {
            searchName = normalizePath(combinePaths(searchPath, moduleName));
            referencedSourceFile = forEach(extensions, extension => {
                if (extension === ".tsx" && !compilerOptions.jsx) {
                    // resolve .tsx files only if jsx support is enabled 
                    // 'logical not' handles both undefined and None cases
                    return undefined;
                }

                const candidate = searchName + extension;
                if (host.fileExists(candidate)) {
                    return candidate;
                }
                else {
                    failedLookupLocations.push(candidate);
                }
            });

            if (referencedSourceFile) {
                break;
            }

            const parentPath = getDirectoryPath(searchPath);
            if (parentPath === searchPath) {
                break;
            }
            searchPath = parentPath;
        }

        return referencedSourceFile
            ? { resolvedModule: { resolvedFileName: referencedSourceFile  }, failedLookupLocations }
            : { resolvedModule: undefined, failedLookupLocations };
    }

    /* @internal */
    export const defaultInitCompilerOptions: CompilerOptions = {
        module: ModuleKind.CommonJS,
        target: ScriptTarget.ES5,
        noImplicitAny: false,
        sourceMap: false,
    };

    export function createCompilerHost(options: CompilerOptions, setParentNodes?: boolean): CompilerHost {
        const existingDirectories: Map<boolean> = {};

        function getCanonicalFileName(fileName: string): string {
            // if underlying system can distinguish between two files whose names differs only in cases then file name already in canonical form.
            // otherwise use toLowerCase as a canonical form.
            return sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
        }

        // returned by CScript sys environment
        const unsupportedFileEncodingErrorCode = -2147024809;

        function getSourceFile(fileName: string, languageVersion: ScriptTarget, onError?: (message: string) => void): SourceFile {
            let text: string;
            try {
                const start = new Date().getTime();
                text = sys.readFile(fileName, options.charset);
                ioReadTime += new Date().getTime() - start;
            }
            catch (e) {
                if (onError) {
                    onError(e.number === unsupportedFileEncodingErrorCode
                        ? createCompilerDiagnostic(Diagnostics.Unsupported_file_encoding).messageText
                        : e.message);
                }
                text = "";
            }

            return text !== undefined ? createSourceFile(fileName, text, languageVersion, setParentNodes) : undefined;
        }

        function directoryExists(directoryPath: string): boolean {
            if (hasProperty(existingDirectories, directoryPath)) {
                return true;
            }
            if (sys.directoryExists(directoryPath)) {
                existingDirectories[directoryPath] = true;
                return true;
            }
            return false;
        }

        function ensureDirectoriesExist(directoryPath: string) {
            if (directoryPath.length > getRootLength(directoryPath) && !directoryExists(directoryPath)) {
                const parentDirectory = getDirectoryPath(directoryPath);
                ensureDirectoriesExist(parentDirectory);
                sys.createDirectory(directoryPath);
            }
        }

        function writeFile(fileName: string, data: string, writeByteOrderMark: boolean, onError?: (message: string) => void) {
            try {
                const start = new Date().getTime();
                ensureDirectoriesExist(getDirectoryPath(normalizePath(fileName)));
                sys.writeFile(fileName, data, writeByteOrderMark);
                ioWriteTime += new Date().getTime() - start;
            }
            catch (e) {
                if (onError) {
                    onError(e.message);
                }
            }
        }

        const newLine = getNewLineCharacter(options);

        return {
            getSourceFile,
            getDefaultLibFileName: options => combinePaths(getDirectoryPath(normalizePath(sys.getExecutingFilePath())), getDefaultLibFileName(options)),
            writeFile,
            getCurrentDirectory: memoize(() => sys.getCurrentDirectory()),
            useCaseSensitiveFileNames: () => sys.useCaseSensitiveFileNames,
            getCanonicalFileName,
            getNewLine: () => newLine,
            fileExists: fileName => sys.fileExists(fileName),
            readFile: fileName => sys.readFile(fileName)
        };
    }

    export function getPreEmitDiagnostics(program: Program, sourceFile?: SourceFile, cancellationToken?: CancellationToken): Diagnostic[] {
        const diagnostics = program.getOptionsDiagnostics(cancellationToken).concat(
                          program.getSyntacticDiagnostics(sourceFile, cancellationToken),
                          program.getGlobalDiagnostics(cancellationToken),
                          program.getSemanticDiagnostics(sourceFile, cancellationToken));

        if (program.getCompilerOptions().declaration) {
            diagnostics.concat(program.getDeclarationDiagnostics(sourceFile, cancellationToken));
        }

        return sortAndDeduplicateDiagnostics(diagnostics);
    }

    export function flattenDiagnosticMessageText(messageText: string | DiagnosticMessageChain, newLine: string): string {
        if (typeof messageText === "string") {
            return messageText;
        }
        else {
            let diagnosticChain = messageText;
            let result = "";

            let indent = 0;
            while (diagnosticChain) {
                if (indent) {
                    result += newLine;

                    for (let i = 0; i < indent; i++) {
                        result += "  ";
                    }
                }
                result += diagnosticChain.messageText;
                indent++;
                diagnosticChain = diagnosticChain.next;
            }

            return result;
        }
    }

    export function createProgram(rootNames: string[], options: CompilerOptions, host?: CompilerHost, oldProgram?: Program): Program {
        let program: Program;
        let files: SourceFile[] = [];
        let fileProcessingDiagnostics = createDiagnosticCollection();
        const programDiagnostics = createDiagnosticCollection();

        let commonSourceDirectory: string;
        let diagnosticsProducingTypeChecker: TypeChecker;
        let noDiagnosticsTypeChecker: TypeChecker;
        let classifiableNames: Map<string>;

        let skipDefaultLib = options.noLib;

        const start = new Date().getTime();

        host = host || createCompilerHost(options);

        const currentDirectory = host.getCurrentDirectory();
        const resolveModuleNamesWorker = host.resolveModuleNames
            ? ((moduleNames: string[], containingFile: string) => host.resolveModuleNames(moduleNames, containingFile))
            : ((moduleNames: string[], containingFile: string) => map(moduleNames, moduleName => resolveModuleName(moduleName, containingFile, options, host).resolvedModule));

        const filesByName = createFileMap<SourceFile>();
        // stores 'filename -> file association' ignoring case
        // used to track cases when two file names differ only in casing 
        const filesByNameIgnoreCase = host.useCaseSensitiveFileNames() ? createFileMap<SourceFile>(fileName => fileName.toLowerCase()) : undefined;

        if (oldProgram) {
            // check properties that can affect structure of the program or module resolution strategy
            // if any of these properties has changed - structure cannot be reused
            const oldOptions = oldProgram.getCompilerOptions();
            if ((oldOptions.module !== options.module) ||
                (oldOptions.noResolve !== options.noResolve) ||
                (oldOptions.target !== options.target) ||
                (oldOptions.noLib !== options.noLib) ||
                (oldOptions.jsx !== options.jsx)) {
                oldProgram = undefined;
            }
        }

        if (!tryReuseStructureFromOldProgram()) {
            forEach(rootNames, name => processRootFile(name, /*isDefaultLib*/ false));
            // Do not process the default library if:
            //  - The '--noLib' flag is used.
            //  - A 'no-default-lib' reference comment is encountered in
            //      processing the root files.
            if (!skipDefaultLib) {
                processRootFile(host.getDefaultLibFileName(options), /*isDefaultLib*/ true);
            }
        }

        verifyCompilerOptions();

        // unconditionally set oldProgram to undefined to prevent it from being captured in closure
        oldProgram = undefined;

        programTime += new Date().getTime() - start;

        program = {
            getRootFileNames: () => rootNames,
            getSourceFile,
            getSourceFiles: () => files,
            getCompilerOptions: () => options,
            getSyntacticDiagnostics,
            getOptionsDiagnostics,
            getGlobalDiagnostics,
            getSemanticDiagnostics,
            getDeclarationDiagnostics,
            getTypeChecker,
            getClassifiableNames,
            getDiagnosticsProducingTypeChecker,
            getCommonSourceDirectory: () => commonSourceDirectory,
            emit,
            getCurrentDirectory: () => currentDirectory,
            getNodeCount: () => getDiagnosticsProducingTypeChecker().getNodeCount(),
            getIdentifierCount: () => getDiagnosticsProducingTypeChecker().getIdentifierCount(),
            getSymbolCount: () => getDiagnosticsProducingTypeChecker().getSymbolCount(),
            getTypeCount: () => getDiagnosticsProducingTypeChecker().getTypeCount(),
            getFileProcessingDiagnostics: () => fileProcessingDiagnostics
        };
        return program;

        function getClassifiableNames() {
            if (!classifiableNames) {
                // Initialize a checker so that all our files are bound.
                getTypeChecker();
                classifiableNames = {};

                for (const sourceFile of files) {
                    copyMap(sourceFile.classifiableNames, classifiableNames);
                }
            }

            return classifiableNames;
        }

        function tryReuseStructureFromOldProgram(): boolean {
            if (!oldProgram) {
                return false;
            }

            Debug.assert(!oldProgram.structureIsReused);

            // there is an old program, check if we can reuse its structure
            const oldRootNames = oldProgram.getRootFileNames();
            if (!arrayIsEqualTo(oldRootNames, rootNames)) {
                return false;
            }

            // check if program source files has changed in the way that can affect structure of the program
            const newSourceFiles: SourceFile[] = [];
            const filePaths: Path[] = [];
            const modifiedSourceFiles: SourceFile[] = [];

            for (const oldSourceFile of oldProgram.getSourceFiles()) {
                let newSourceFile = host.getSourceFile(oldSourceFile.fileName, options.target);
                if (!newSourceFile) {
                    return false;
                }

                newSourceFile.path = oldSourceFile.path;
                filePaths.push(newSourceFile.path);

                if (oldSourceFile !== newSourceFile) {
                    if (oldSourceFile.hasNoDefaultLib !== newSourceFile.hasNoDefaultLib) {
                        // value of no-default-lib has changed
                        // this will affect if default library is injected into the list of files
                        return false;
                    }

                    // check tripleslash references
                    if (!arrayIsEqualTo(oldSourceFile.referencedFiles, newSourceFile.referencedFiles, fileReferenceIsEqualTo)) {
                        // tripleslash references has changed
                        return false;
                    }

                    // check imports
                    collectExternalModuleReferences(newSourceFile);
                    if (!arrayIsEqualTo(oldSourceFile.imports, newSourceFile.imports, moduleNameIsEqualTo)) {
                        // imports has changed
                        return false;
                    }

                    if (resolveModuleNamesWorker) {
                        const moduleNames = map(newSourceFile.imports, name => name.text);
                        const resolutions = resolveModuleNamesWorker(moduleNames, getNormalizedAbsolutePath(newSourceFile.fileName, currentDirectory));
                        // ensure that module resolution results are still correct
                        for (let i = 0; i < moduleNames.length; ++i) {
                            const newResolution = resolutions[i];
                            const oldResolution = getResolvedModule(oldSourceFile, moduleNames[i]);
                            const resolutionChanged = oldResolution
                                ? !newResolution ||
                                  oldResolution.resolvedFileName !== newResolution.resolvedFileName ||
                                  !!oldResolution.isExternalLibraryImport !== !!newResolution.isExternalLibraryImport
                                : newResolution;

                            if (resolutionChanged) {
                                return false;
                            }
                        }
                    }
                    // pass the cache of module resolutions from the old source file
                    newSourceFile.resolvedModules = oldSourceFile.resolvedModules;
                    modifiedSourceFiles.push(newSourceFile);
                }
                else {
                    // file has no changes - use it as is
                    newSourceFile = oldSourceFile;
                }

                // if file has passed all checks it should be safe to reuse it
                newSourceFiles.push(newSourceFile);
            }

            // update fileName -> file mapping
            for (let i = 0, len = newSourceFiles.length; i < len; ++i) {
                filesByName.set(filePaths[i], newSourceFiles[i]);
            }

            files = newSourceFiles;
            fileProcessingDiagnostics = oldProgram.getFileProcessingDiagnostics();

            for (const modifiedFile of modifiedSourceFiles) {
                fileProcessingDiagnostics.reattachFileDiagnostics(modifiedFile);
            }
            oldProgram.structureIsReused = true;

            return true;
        }

        function getEmitHost(writeFileCallback?: WriteFileCallback): EmitHost {
            return {
                getCanonicalFileName,
                getCommonSourceDirectory: program.getCommonSourceDirectory,
                getCompilerOptions: program.getCompilerOptions,
                getCurrentDirectory: () => currentDirectory,
                getNewLine: () => host.getNewLine(),
                getSourceFile: program.getSourceFile,
                getSourceFiles: program.getSourceFiles,
                writeFile: writeFileCallback || (
                    (fileName, data, writeByteOrderMark, onError) => host.writeFile(fileName, data, writeByteOrderMark, onError)),
            };
        }

        function getDiagnosticsProducingTypeChecker() {
            return diagnosticsProducingTypeChecker || (diagnosticsProducingTypeChecker = createTypeChecker(program, /*produceDiagnostics:*/ true));
        }

        function getTypeChecker() {
            return noDiagnosticsTypeChecker || (noDiagnosticsTypeChecker = createTypeChecker(program, /*produceDiagnostics:*/ false));
        }

        function emit(sourceFile?: SourceFile, writeFileCallback?: WriteFileCallback, cancellationToken?: CancellationToken): EmitResult {
            return runWithCancellationToken(() => emitWorker(this, sourceFile, writeFileCallback, cancellationToken));
        }

        function emitWorker(program: Program, sourceFile: SourceFile, writeFileCallback: WriteFileCallback, cancellationToken: CancellationToken): EmitResult {
            // If the noEmitOnError flag is set, then check if we have any errors so far.  If so,
            // immediately bail out.  Note that we pass 'undefined' for 'sourceFile' so that we
            // get any preEmit diagnostics, not just the ones
            if (options.noEmitOnError && getPreEmitDiagnostics(program, /*sourceFile:*/ undefined, cancellationToken).length > 0) {
                return { diagnostics: [], sourceMaps: undefined, emitSkipped: true };
            }

            // Create the emit resolver outside of the "emitTime" tracking code below.  That way
            // any cost associated with it (like type checking) are appropriate associated with
            // the type-checking counter.
            //
            // If the -out option is specified, we should not pass the source file to getEmitResolver.
            // This is because in the -out scenario all files need to be emitted, and therefore all
            // files need to be type checked. And the way to specify that all files need to be type
            // checked is to not pass the file to getEmitResolver.
            const emitResolver = getDiagnosticsProducingTypeChecker().getEmitResolver((options.outFile || options.out) ? undefined : sourceFile);

            const start = new Date().getTime();

            const emitResult = emitFiles(
                emitResolver,
                getEmitHost(writeFileCallback),
                sourceFile);

            emitTime += new Date().getTime() - start;
            return emitResult;
        }

        function getSourceFile(fileName: string): SourceFile {
            return filesByName.get(toPath(fileName, currentDirectory, getCanonicalFileName));
        }

        function getDiagnosticsHelper(
                sourceFile: SourceFile,
                getDiagnostics: (sourceFile: SourceFile, cancellationToken: CancellationToken) => Diagnostic[],
                cancellationToken: CancellationToken): Diagnostic[] {
            if (sourceFile) {
                return getDiagnostics(sourceFile, cancellationToken);
            }

            const allDiagnostics: Diagnostic[] = [];
            forEach(program.getSourceFiles(), sourceFile => {
                if (cancellationToken) {
                    cancellationToken.throwIfCancellationRequested();
                }
                addRange(allDiagnostics, getDiagnostics(sourceFile, cancellationToken));
            });

            return sortAndDeduplicateDiagnostics(allDiagnostics);
        }

        function getSyntacticDiagnostics(sourceFile: SourceFile, cancellationToken: CancellationToken): Diagnostic[] {
            return getDiagnosticsHelper(sourceFile, getSyntacticDiagnosticsForFile, cancellationToken);
        }

        function getSemanticDiagnostics(sourceFile: SourceFile, cancellationToken: CancellationToken): Diagnostic[] {
            return getDiagnosticsHelper(sourceFile, getSemanticDiagnosticsForFile, cancellationToken);
        }

        function getDeclarationDiagnostics(sourceFile: SourceFile, cancellationToken: CancellationToken): Diagnostic[] {
            return getDiagnosticsHelper(sourceFile, getDeclarationDiagnosticsForFile, cancellationToken);
        }

        function getSyntacticDiagnosticsForFile(sourceFile: SourceFile, cancellationToken: CancellationToken): Diagnostic[] {
            return sourceFile.parseDiagnostics;
        }

        function runWithCancellationToken<T>(func: () => T): T {
            try {
                return func();
            }
            catch (e) {
                if (e instanceof OperationCanceledException) {
                    // We were canceled while performing the operation.  Because our type checker
                    // might be a bad state, we need to throw it away.
                    //
                    // Note: we are overly agressive here.  We do not actually *have* to throw away
                    // the "noDiagnosticsTypeChecker".  However, for simplicity, i'd like to keep
                    // the lifetimes of these two TypeCheckers the same.  Also, we generally only
                    // cancel when the user has made a change anyways.  And, in that case, we (the
                    // program instance) will get thrown away anyways.  So trying to keep one of
                    // these type checkers alive doesn't serve much purpose.
                    noDiagnosticsTypeChecker = undefined;
                    diagnosticsProducingTypeChecker = undefined;
                }

                throw e;
            }
        }

        function getSemanticDiagnosticsForFile(sourceFile: SourceFile, cancellationToken: CancellationToken): Diagnostic[] {
            return runWithCancellationToken(() => {
                const typeChecker = getDiagnosticsProducingTypeChecker();

                Debug.assert(!!sourceFile.bindDiagnostics);
                const bindDiagnostics = sourceFile.bindDiagnostics;
                const checkDiagnostics = typeChecker.getDiagnostics(sourceFile, cancellationToken);
                const fileProcessingDiagnosticsInFile = fileProcessingDiagnostics.getDiagnostics(sourceFile.fileName);
                const programDiagnosticsInFile = programDiagnostics.getDiagnostics(sourceFile.fileName);

                return bindDiagnostics.concat(checkDiagnostics).concat(fileProcessingDiagnosticsInFile).concat(programDiagnosticsInFile);
            });
        }

        function getDeclarationDiagnosticsForFile(sourceFile: SourceFile, cancellationToken: CancellationToken): Diagnostic[] {
            return runWithCancellationToken(() => {
                if (!isDeclarationFile(sourceFile)) {
                    const resolver = getDiagnosticsProducingTypeChecker().getEmitResolver(sourceFile, cancellationToken);
                    // Don't actually write any files since we're just getting diagnostics.
                    const writeFile: WriteFileCallback = () => { };
                    return ts.getDeclarationDiagnostics(getEmitHost(writeFile), resolver, sourceFile);
                }
            });
        }

        function getOptionsDiagnostics(): Diagnostic[] {
            const allDiagnostics: Diagnostic[] = [];
            addRange(allDiagnostics, fileProcessingDiagnostics.getGlobalDiagnostics());
            addRange(allDiagnostics, programDiagnostics.getGlobalDiagnostics());
            return sortAndDeduplicateDiagnostics(allDiagnostics);
        }

        function getGlobalDiagnostics(): Diagnostic[] {
            const allDiagnostics: Diagnostic[] = [];
            addRange(allDiagnostics, getDiagnosticsProducingTypeChecker().getGlobalDiagnostics());
            return sortAndDeduplicateDiagnostics(allDiagnostics);
        }

        function hasExtension(fileName: string): boolean {
            return getBaseFileName(fileName).indexOf(".") >= 0;
        }

        function processRootFile(fileName: string, isDefaultLib: boolean) {
            processSourceFile(normalizePath(fileName), isDefaultLib);
        }

        function fileReferenceIsEqualTo(a: FileReference, b: FileReference): boolean {
            return a.fileName === b.fileName;
        }

        function moduleNameIsEqualTo(a: LiteralExpression, b: LiteralExpression): boolean {
            return a.text === b.text;
        }

        function collectExternalModuleReferences(file: SourceFile): void {
            if (file.imports) {
                return;
            }

            const isJavaScriptFile = isSourceFileJavaScript(file);

            let imports: LiteralExpression[];
            for (const node of file.statements) {
                collect(node, /*allowRelativeModuleNames*/ true, /*collectOnlyRequireCalls*/ false);
            }

            file.imports = imports || emptyArray;

            return;

            function collect(node: Node, allowRelativeModuleNames: boolean, collectOnlyRequireCalls: boolean): void {
                if (!collectOnlyRequireCalls) {
                    switch (node.kind) {
                        case SyntaxKind.ImportDeclaration:
                        case SyntaxKind.ImportEqualsDeclaration:
                        case SyntaxKind.ExportDeclaration:
                            let moduleNameExpr = getExternalModuleName(node);
                            if (!moduleNameExpr || moduleNameExpr.kind !== SyntaxKind.StringLiteral) {
                                break;
                            }
                            if (!(<LiteralExpression>moduleNameExpr).text) {
                                break;
                            }

                            if (allowRelativeModuleNames || !isExternalModuleNameRelative((<LiteralExpression>moduleNameExpr).text)) {
                                (imports || (imports = [])).push(<LiteralExpression>moduleNameExpr);
                            }
                            break;
                        case SyntaxKind.ModuleDeclaration:
                            if ((<ModuleDeclaration>node).name.kind === SyntaxKind.StringLiteral && (node.flags & NodeFlags.Ambient || isDeclarationFile(file))) {
                                // TypeScript 1.0 spec (April 2014): 12.1.6
                                // An AmbientExternalModuleDeclaration declares an external module. 
                                // This type of declaration is permitted only in the global module.
                                // The StringLiteral must specify a top - level external module name.
                                // Relative external module names are not permitted
                                forEachChild((<ModuleDeclaration>node).body, node => {
                                    // TypeScript 1.0 spec (April 2014): 12.1.6
                                    // An ExternalImportDeclaration in anAmbientExternalModuleDeclaration may reference other external modules 
                                    // only through top - level external module names. Relative external module names are not permitted.
                                    collect(node, /*allowRelativeModuleNames*/ false, collectOnlyRequireCalls);
                                });
                            }
                            break;
                    }
                }

                if (isJavaScriptFile) {
                    if (isRequireCall(node)) {
                        (imports || (imports = [])).push(<StringLiteral>(<CallExpression>node).arguments[0]);
                    }
                    else {
                        forEachChild(node, node => collect(node, allowRelativeModuleNames, /*collectOnlyRequireCalls*/ true));
                    }
                }
            }
        }

        function processSourceFile(fileName: string, isDefaultLib: boolean, refFile?: SourceFile, refPos?: number, refEnd?: number) {
            let diagnosticArgument: string[];
            let diagnostic: DiagnosticMessage;
            if (hasExtension(fileName)) {
                if (!options.allowNonTsExtensions && !forEach(supportedExtensions, extension => fileExtensionIs(host.getCanonicalFileName(fileName), extension))) {
                    diagnostic = Diagnostics.File_0_has_unsupported_extension_The_only_supported_extensions_are_1;
                    diagnosticArgument = [fileName, "'" + supportedExtensions.join("', '") + "'"];
                }
                else if (!findSourceFile(fileName, toPath(fileName, currentDirectory, getCanonicalFileName), isDefaultLib, refFile, refPos, refEnd)) {
                    diagnostic = Diagnostics.File_0_not_found;
                    diagnosticArgument = [fileName];
                }
                else if (refFile && host.getCanonicalFileName(fileName) === host.getCanonicalFileName(refFile.fileName)) {
                    diagnostic = Diagnostics.A_file_cannot_have_a_reference_to_itself;
                    diagnosticArgument = [fileName];
                }
            }
            else {
                const nonTsFile: SourceFile = options.allowNonTsExtensions && findSourceFile(fileName, toPath(fileName, currentDirectory, getCanonicalFileName), isDefaultLib, refFile, refPos, refEnd);
                if (!nonTsFile) {
                    if (options.allowNonTsExtensions) {
                        diagnostic = Diagnostics.File_0_not_found;
                        diagnosticArgument = [fileName];
                    }
                    else if (!forEach(supportedExtensions, extension => findSourceFile(fileName + extension, toPath(fileName + extension, currentDirectory, getCanonicalFileName), isDefaultLib, refFile, refPos, refEnd))) {
                        diagnostic = Diagnostics.File_0_not_found;
                        fileName += ".ts";
                        diagnosticArgument = [fileName];
                    }
                }
            }

            if (diagnostic) {
                if (refFile !== undefined && refEnd !== undefined && refPos !== undefined) {
                    fileProcessingDiagnostics.add(createFileDiagnostic(refFile, refPos, refEnd - refPos, diagnostic, ...diagnosticArgument));
                }
                else {
                    fileProcessingDiagnostics.add(createCompilerDiagnostic(diagnostic, ...diagnosticArgument));
                }
            }
        }

        function reportFileNamesDifferOnlyInCasingError(fileName: string, existingFileName: string, refFile: SourceFile, refPos: number, refEnd: number): void {
            if (refFile !== undefined && refPos !== undefined && refEnd !== undefined) {
                fileProcessingDiagnostics.add(createFileDiagnostic(refFile, refPos, refEnd - refPos,
                    Diagnostics.File_name_0_differs_from_already_included_file_name_1_only_in_casing, fileName, existingFileName));
            }
            else {
                fileProcessingDiagnostics.add(createCompilerDiagnostic(Diagnostics.File_name_0_differs_from_already_included_file_name_1_only_in_casing, fileName, existingFileName));
            }
        }

        // Get source file from normalized fileName
        function findSourceFile(fileName: string, path: Path, isDefaultLib: boolean, refFile?: SourceFile, refPos?: number, refEnd?: number): SourceFile {
            if (filesByName.contains(path)) {
                const file = filesByName.get(path);
                // try to check if we've already seen this file but with a different casing in path
                // NOTE: this only makes sense for case-insensitive file systems
                if (file && options.forceConsistentCasingInFileNames && getNormalizedAbsolutePath(file.fileName, currentDirectory) !== getNormalizedAbsolutePath(fileName, currentDirectory)) {
                    reportFileNamesDifferOnlyInCasingError(fileName, file.fileName, refFile, refPos, refEnd);
                }

                return file;
            }

            // We haven't looked for this file, do so now and cache result
            const file = host.getSourceFile(fileName, options.target, hostErrorMessage => {
                if (refFile !== undefined && refPos !== undefined && refEnd !== undefined) {
                    fileProcessingDiagnostics.add(createFileDiagnostic(refFile, refPos, refEnd - refPos,
                        Diagnostics.Cannot_read_file_0_Colon_1, fileName, hostErrorMessage));
                }
                else {
                    fileProcessingDiagnostics.add(createCompilerDiagnostic(Diagnostics.Cannot_read_file_0_Colon_1, fileName, hostErrorMessage));
                }
            });

            filesByName.set(path, file);
            if (file) {
                file.path = path;

                if (host.useCaseSensitiveFileNames()) {
                    // for case-sensitive file systems check if we've already seen some file with similar filename ignoring case
                    const existingFile = filesByNameIgnoreCase.get(path);
                    if (existingFile) {
                        reportFileNamesDifferOnlyInCasingError(fileName, existingFile.fileName, refFile, refPos, refEnd);
                    }
                    else {
                        filesByNameIgnoreCase.set(path, file);
                    }
                }

                skipDefaultLib = skipDefaultLib || file.hasNoDefaultLib;

                const basePath = getDirectoryPath(fileName);
                if (!options.noResolve) {
                    processReferencedFiles(file, basePath);
                }

                // always process imported modules to record module name resolutions
                processImportedModules(file, basePath);

                if (isDefaultLib) {
                    files.unshift(file);
                }
                else {
                    files.push(file);
                }
            }

            return file;
        }

        function processReferencedFiles(file: SourceFile, basePath: string) {
            forEach(file.referencedFiles, ref => {
                const referencedFileName = resolveTripleslashReference(ref.fileName, file.fileName);
                processSourceFile(referencedFileName, /*isDefaultLib*/ false, file, ref.pos, ref.end);
            });
        }

        function getCanonicalFileName(fileName: string): string {
            return host.getCanonicalFileName(fileName);
        }

        function processImportedModules(file: SourceFile, basePath: string) {
            collectExternalModuleReferences(file);
            if (file.imports.length) {
                file.resolvedModules = {};
                const moduleNames = map(file.imports, name => name.text);
                const resolutions = resolveModuleNamesWorker(moduleNames, getNormalizedAbsolutePath(file.fileName, currentDirectory));
                for (let i = 0; i < file.imports.length; ++i) {
                    const resolution = resolutions[i];
                    setResolvedModule(file, moduleNames[i], resolution);
                    if (resolution && !options.noResolve) {
                        const importedFile = findSourceFile(resolution.resolvedFileName, toPath(resolution.resolvedFileName, currentDirectory, getCanonicalFileName), /*isDefaultLib*/ false, file, skipTrivia(file.text, file.imports[i].pos), file.imports[i].end);

                        if (importedFile && resolution.isExternalLibraryImport) {
                            if (!isExternalModule(importedFile)) {
                                const start = getTokenPosOfNode(file.imports[i], file);
                                fileProcessingDiagnostics.add(createFileDiagnostic(file, start, file.imports[i].end - start, Diagnostics.Exported_external_package_typings_file_0_is_not_a_module_Please_contact_the_package_author_to_update_the_package_definition, importedFile.fileName));
                            }
                            else if (importedFile.referencedFiles.length) {
                                const firstRef = importedFile.referencedFiles[0];
                                fileProcessingDiagnostics.add(createFileDiagnostic(importedFile, firstRef.pos, firstRef.end - firstRef.pos, Diagnostics.Exported_external_package_typings_file_cannot_contain_tripleslash_references_Please_contact_the_package_author_to_update_the_package_definition));
                            }
                        }
                    }
                }
            }
            else {
                // no imports - drop cached module resolutions
                file.resolvedModules = undefined;
            }
            return;
        }

        function computeCommonSourceDirectory(sourceFiles: SourceFile[]): string {
            let commonPathComponents: string[];
            const failed = forEach(files, sourceFile => {
                // Each file contributes into common source file path
                if (isDeclarationFile(sourceFile)) {
                    return;
                }

                const sourcePathComponents = getNormalizedPathComponents(sourceFile.fileName, currentDirectory);
                sourcePathComponents.pop(); // The base file name is not part of the common directory path

                if (!commonPathComponents) {
                    // first file
                    commonPathComponents = sourcePathComponents;
                    return;
                }

                for (let i = 0, n = Math.min(commonPathComponents.length, sourcePathComponents.length); i < n; i++) {
                    if (getCanonicalFileName(commonPathComponents[i]) !== getCanonicalFileName(sourcePathComponents[i])) {
                        if (i === 0) {
                            // Failed to find any common path component
                            return true;
                        }

                        // New common path found that is 0 -> i-1
                        commonPathComponents.length = i;
                        break;
                    }
                }

                // If the sourcePathComponents was shorter than the commonPathComponents, truncate to the sourcePathComponents
                if (sourcePathComponents.length < commonPathComponents.length) {
                    commonPathComponents.length = sourcePathComponents.length;
                }
            });

            // A common path can not be found when paths span multiple drives on windows, for example
            if (failed) {
                return "";
            }

            if (!commonPathComponents) { // Can happen when all input files are .d.ts files
                return currentDirectory;
            }

            return getNormalizedPathFromPathComponents(commonPathComponents);
        }

        function checkSourceFilesBelongToPath(sourceFiles: SourceFile[], rootDirectory: string): boolean {
            let allFilesBelongToPath = true;
            if (sourceFiles) {
                const absoluteRootDirectoryPath = host.getCanonicalFileName(getNormalizedAbsolutePath(rootDirectory, currentDirectory));

                for (var sourceFile of sourceFiles) {
                    if (!isDeclarationFile(sourceFile)) {
                        const absoluteSourceFilePath = host.getCanonicalFileName(getNormalizedAbsolutePath(sourceFile.fileName, currentDirectory));
                        if (absoluteSourceFilePath.indexOf(absoluteRootDirectoryPath) !== 0) {
                            programDiagnostics.add(createCompilerDiagnostic(Diagnostics.File_0_is_not_under_rootDir_1_rootDir_is_expected_to_contain_all_source_files, sourceFile.fileName, options.rootDir));
                            allFilesBelongToPath = false;
                        }
                    }
                }
            }

            return allFilesBelongToPath;
        }

        function verifyCompilerOptions() {
            if (options.isolatedModules) {
                if (options.declaration) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "declaration", "isolatedModules"));
                }

                if (options.noEmitOnError) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "noEmitOnError", "isolatedModules"));
                }

                if (options.out) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "out", "isolatedModules"));
                }

                if (options.outFile) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "outFile", "isolatedModules"));
                }
            }

            if (options.inlineSourceMap) {
                if (options.sourceMap) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "sourceMap", "inlineSourceMap"));
                }
                if (options.mapRoot) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "mapRoot", "inlineSourceMap"));
                }
            }

            if (options.moduleResolution === ModuleResolutionKind.BaseUrl) {
                if (options.baseUrl === undefined && options.inferredBaseUrl === undefined) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.moduleResolution_kind_BaseUrl_cannot_be_used_without_specifying_baseUrl_option));
                }
            }
            else if (options.moduleResolution === undefined) {
                // if module resolution kind is not specified it is an error to have baseUrl and module === CommonJs 
                // since the former one implies moduleResolutionKind to be BaseUrl and the latter one - Node 
                if (options.module === ModuleKind.CommonJS && options.baseUrl) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Module_resolution_kind_cannot_be_determined_automatically_Please_specify_module_resolution_explicitly_via_moduleResolution_option));
                }
            }
            else {
                // here it is known that moduleResolution is not baseurl and is not undefined
                if (options.baseUrl !== undefined) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_can_only_be_used_when_option_moduleResolution_is_BaseUrl, "baseUrl"));
                }
                if (options.paths) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_can_only_be_used_when_option_moduleResolution_is_BaseUrl, "paths"));
                }
                if (options.rootDirs) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_can_only_be_used_when_option_moduleResolution_is_BaseUrl, "rootDirs"));
                }
            }

            if (options.paths) {
                for (const key in options.paths) {
                    if (!hasProperty(options.paths, key)) {
                        continue;
                    }
                    if (getNumberOfChars(key, CharacterCodes.asterisk) > 1) {
                        programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Pattern_0_can_have_at_most_one_Asterisk_character, key));
                    }
                    for (const subst of options.paths[key]) {
                        if (getNumberOfChars(subst, CharacterCodes.asterisk) > 1) {
                            programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Substitution_0_in_pattern_1_in_can_have_at_most_one_Asterisk_character, subst, key));
                        }
                    }
                }
            }

            if (options.inlineSources) {
                if (!options.sourceMap && !options.inlineSourceMap) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_inlineSources_can_only_be_used_when_either_option_inlineSourceMap_or_option_sourceMap_is_provided));
                }
                if (options.sourceRoot) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "sourceRoot", "inlineSources"));
                }
            }

            if (options.out && options.outFile) {
                programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "out", "outFile"));
            }

            if (!options.sourceMap && (options.mapRoot || options.sourceRoot)) {
                // Error to specify --mapRoot or --sourceRoot without mapSourceFiles
                if (options.mapRoot) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1, "mapRoot", "sourceMap"));
                }
                if (options.sourceRoot && !options.inlineSourceMap) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1, "sourceRoot", "sourceMap"));
                }
            }

            const languageVersion = options.target || ScriptTarget.ES3;
            const outFile = options.outFile || options.out;

            const firstExternalModuleSourceFile = forEach(files, f => isExternalModule(f) ? f : undefined);
            if (options.isolatedModules) {
                if (!options.module && languageVersion < ScriptTarget.ES6) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_isolatedModules_can_only_be_used_when_either_option_module_is_provided_or_option_target_is_ES2015_or_higher));
                }

                const firstNonExternalModuleSourceFile = forEach(files, f => !isExternalModule(f) && !isDeclarationFile(f) ? f : undefined);
                if (firstNonExternalModuleSourceFile) {
                    const span = getErrorSpanForNode(firstNonExternalModuleSourceFile, firstNonExternalModuleSourceFile);
                    programDiagnostics.add(createFileDiagnostic(firstNonExternalModuleSourceFile, span.start, span.length, Diagnostics.Cannot_compile_namespaces_when_the_isolatedModules_flag_is_provided));
                }
            }
            else if (firstExternalModuleSourceFile && languageVersion < ScriptTarget.ES6 && !options.module) {
                // We cannot use createDiagnosticFromNode because nodes do not have parents yet
                const span = getErrorSpanForNode(firstExternalModuleSourceFile, firstExternalModuleSourceFile.externalModuleIndicator);
                programDiagnostics.add(createFileDiagnostic(firstExternalModuleSourceFile, span.start, span.length, Diagnostics.Cannot_compile_modules_unless_the_module_flag_is_provided));
            }

            // Cannot specify module gen target of es6 when below es6
            if (options.module === ModuleKind.ES6 && languageVersion < ScriptTarget.ES6) {
                programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Cannot_compile_modules_into_es2015_when_targeting_ES5_or_lower));
            }

            // Cannot specify module gen that isn't amd or system with --out
            if (outFile && options.module && !(options.module === ModuleKind.AMD || options.module === ModuleKind.System)) {
                programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Only_amd_and_system_modules_are_supported_alongside_0, options.out ? "out" : "outFile"));
            }

            // there has to be common source directory if user specified --outdir || --sourceRoot
            // if user specified --mapRoot, there needs to be common source directory if there would be multiple files being emitted
            if (options.outDir || // there is --outDir specified
                options.sourceRoot || // there is --sourceRoot specified
                options.mapRoot) { // there is --mapRoot specified

                if (options.rootDir && checkSourceFilesBelongToPath(files, options.rootDir)) {
                    // If a rootDir is specified and is valid use it as the commonSourceDirectory
                    commonSourceDirectory = getNormalizedAbsolutePath(options.rootDir, currentDirectory);
                }
                else {
                    // Compute the commonSourceDirectory from the input files
                    commonSourceDirectory = computeCommonSourceDirectory(files);
                    // If we failed to find a good common directory, but outDir is specified and at least one of our files is on a windows drive/URL/other resource, add a failure
                    if (options.outDir && commonSourceDirectory === "" && forEach(files, file => getRootLength(file.fileName) > 1)) {
                            programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Cannot_find_the_common_subdirectory_path_for_the_input_files));
                    }
                }

                if (commonSourceDirectory && commonSourceDirectory[commonSourceDirectory.length - 1] !== directorySeparator) {
                    // Make sure directory path ends with directory separator so this string can directly
                    // used to replace with "" to get the relative path of the source file and the relative path doesn't
                    // start with / making it rooted path
                    commonSourceDirectory += directorySeparator;
                }
            }

            if (options.noEmit) {
                if (options.out) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "noEmit", "out"));
                }

                if (options.outFile) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "noEmit", "outFile"));
                }

                if (options.outDir) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "noEmit", "outDir"));
                }

                if (options.declaration) {
                    programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_with_option_1, "noEmit", "declaration"));
                }
            }

            if (options.emitDecoratorMetadata &&
                !options.experimentalDecorators) {
                programDiagnostics.add(createCompilerDiagnostic(Diagnostics.Option_0_cannot_be_specified_without_specifying_option_1, "emitDecoratorMetadata", "experimentalDecorators"));
            }
        }
    }
}
