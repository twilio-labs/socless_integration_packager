"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var bluebird_1 = __importDefault(require("bluebird"));
var fs_extra_1 = __importDefault(require("fs-extra"));
var path_1 = __importDefault(require("path"));
var child_process_1 = __importDefault(require("child_process"));
var zip_local_1 = __importDefault(require("zip-local"));
var upath_1 = __importDefault(require("upath"));
var readline_sync_1 = __importDefault(require("readline-sync"));
bluebird_1.default.promisifyAll(fs_extra_1.default);
var FULL_PLUGIN_NAME = "socless_integration_packager";
var SoclessPackager = /** @class */ (function () {
    // serverless: Serverless.Instance;
    // commands: Serverless.CommandsDefinition;
    function SoclessPackager(serverless, options) {
        var _this = this;
        this.serverless = serverless;
        this.options = options;
        this.log = function (msg) {
            _this.serverless.cli.log("[".concat(FULL_PLUGIN_NAME, "] ").concat(msg));
        };
        this.error = function (msg) {
            throw new Error("[".concat(FULL_PLUGIN_NAME, "] ").concat(msg));
        };
        this.config = this.buildConfig();
        this.hooks = {
            "before:package:createDeploymentArtifacts": function () {
                return bluebird_1.default.bind(_this)
                    .then(_this.buildConfig)
                    .then(_this.autoconfigArtifacts)
                    .then(function () {
                    fs_extra_1.default.ensureDir(_this.config.buildDir);
                })
                    .then(_this.setupDocker)
                    .then(_this.selectAll)
                    .map(_this.makePackage);
            },
            "after:deploy:deploy": function () { return bluebird_1.default.bind(_this).then(_this.clean); },
        };
    }
    SoclessPackager.prototype.buildConfig = function () {
        if (!this.serverless.service.custom) {
            this.error("No serverless custom configurations are defined");
        }
        var custom = this.serverless.service.custom.soclessPackager;
        if (!custom) {
            this.error("No ".concat(FULL_PLUGIN_NAME, " configuration detected. Please see documentation"));
        }
        var globalRequirements = custom.globalRequirements || ["./functions/requirements.txt"];
        if (!Array.isArray(globalRequirements)) {
            globalRequirements = [globalRequirements];
        }
        var globalIncludes = custom.globalIncludes || ["./common_files"];
        if (!Array.isArray(globalIncludes)) {
            globalIncludes = [globalIncludes];
        }
        var config = {
            buildDir: custom.buildDir || this.error("No buildDir configuration specified"),
            requirementsFile: custom.requirementsFile || "requirements.txt",
            globalRequirements: globalRequirements,
            globalIncludes: globalIncludes,
            cleanup: custom.cleanup === undefined ? true : custom.cleanup,
            useDocker: custom.useDocker === undefined ? true : custom.useDocker,
            dockerImage: custom.dockerImage || "lambci/lambda:build-".concat(this.serverless.service.provider.runtime),
            containerName: custom.containerName || FULL_PLUGIN_NAME,
            mountSSH: custom.mountSSH === undefined ? false : custom.mountSSH,
            dockerEnvs: custom.dockerEnvs || [],
            abortOnPackagingErrors: custom.abortOnPackagingErrors === undefined ? true : custom.abortOnPackagingErrors,
            dockerServicePath: "/var/task",
        };
        this.config = config;
        return config;
    };
    SoclessPackager.prototype.autoconfigArtifacts = function () {
        var _this = this;
        // TODO: confirm these two functions have the same effect
        Object.entries(this.serverless.service.functions).map(function (_a) {
            var slsFuncName = _a[0], funcConfig = _a[1];
            var autoArtifact = "".concat(_this.config.buildDir, "/").concat(funcConfig.name, ".zip");
            funcConfig.package = funcConfig.package || {};
            funcConfig.package.artifact = funcConfig.package.artifact || autoArtifact;
            _this.serverless.service.functions[slsFuncName] = funcConfig;
        });
        // _.map(this.serverless.service.functions, (func_config, func_name) => {
        //   let autoArtifact = `${this.config.buildDir}/${func_config.name}.zip`;
        //   func_config.package.artifact = func_config.package.artifact || autoArtifact;
        //   this.serverless.service.functions[func_name] = func_config;
        // });
    };
    SoclessPackager.prototype.clean = function () {
        var _this = this;
        if (!this.config.cleanup) {
            this.log('Cleanup is set to "false". Build directory and Docker container (if used) will be retained');
            return false;
        }
        this.log("Cleaning build directory...");
        fs_extra_1.default.remove(this.config.buildDir).catch(function (err) {
            _this.log(err);
        });
        if (this.config.useDocker) {
            this.log("Removing Docker container...");
            this.runProcess("docker", ["stop", this.config.containerName, "-t", "0"]);
        }
        return true;
    };
    SoclessPackager.prototype.selectAll = function () {
        // TODO: confirm these two functions have the same outcome. TS did not like the first one (written in olddd JS)
        // const functions = _.reject(this.serverless.service.functions, (target) => {
        //   return target.runtime && !(target.runtime + "").match(/python/i);
        // });
        var functions = Object.values(this.serverless.service.functions).filter(function (target) {
            return target.runtime !== undefined && target.runtime.includes("python");
        });
        var info = functions.map(function (target) {
            var tgtPackage = target.package || {};
            return {
                name: target.name,
                // TODO: `include` is deprecated, move to `patterns`
                includes: tgtPackage.include,
                artifact: tgtPackage.artifact,
            };
        });
        return info;
    };
    SoclessPackager.prototype.installRequirements = function (buildPath, requirementsPath) {
        if (!fs_extra_1.default.pathExistsSync(requirementsPath)) {
            return;
        }
        var size = fs_extra_1.default.statSync(requirementsPath).size;
        if (size === 0) {
            this.log("WARNING: requirements file at ".concat(requirementsPath, " is empty. Skiping."));
            return;
        }
        var cmd = "pip";
        var args = ["install", "--upgrade", "-t", upath_1.default.normalize(buildPath), "-r"];
        if (this.config.useDocker === true) {
            cmd = "docker";
            args = __spreadArray(["exec", this.config.containerName, "pip"], args, true);
            requirementsPath = "".concat(this.config.dockerServicePath, "/").concat(requirementsPath);
        }
        args = __spreadArray(__spreadArray([], args, true), [upath_1.default.normalize(requirementsPath)], false);
        return this.runProcess(cmd, args);
    };
    SoclessPackager.prototype.checkDocker = function () {
        var out = this.runProcess("docker", [
            "version",
            "-f",
            "Server Version {{.Server.Version}} & Client Version {{.Client.Version}}",
        ]);
        this.log("Using Docker ".concat(out));
    };
    SoclessPackager.prototype.runProcess = function (cmd, args) {
        var ret = child_process_1.default.spawnSync(cmd, args);
        if (ret.error) {
            this.error(ret.error.message);
        }
        var out = ret.stdout.toString();
        if (ret.stderr.length != 0) {
            var errorText = ret.stderr.toString().trim();
            this.log(errorText); // prints stderr
            if (this.config.abortOnPackagingErrors) {
                var countErrorNewLines = errorText.split("\n").length;
                if (!errorText.includes("ERROR:") &&
                    ((countErrorNewLines < 2 && errorText.toLowerCase().includes("git clone")) ||
                        (countErrorNewLines < 3 && errorText.toLowerCase().includes("git checkout")))) {
                    // Ignore false positive due to pip git clone printing to stderr
                }
                else if (errorText.toLowerCase().includes("warning") &&
                    !errorText.toLowerCase().includes("error")) {
                    // Ignore warnings
                }
                else if (errorText.toLowerCase().includes("docker")) {
                    console.log("stdout:", out);
                    this.error("Docker Error Detected");
                }
                else {
                    // Error is not false positive,
                    console.log("___ERROR DETECTED, BEGIN STDOUT____\n", out);
                    this.requestUserConfirmation();
                }
            }
        }
        return out;
    };
    SoclessPackager.prototype.requestUserConfirmation = function (prompt, yesText, noText) {
        if (prompt === void 0) { prompt = "\n\n??? Do you wish to continue deployment with the stated errors? \n"; }
        if (yesText === void 0) { yesText = "Continuing Deployment!"; }
        if (noText === void 0) { noText = "ABORTING DEPLOYMENT"; }
        var response = readline_sync_1.default.question(prompt);
        if (response.toLowerCase().includes("y")) {
            console.log(yesText);
            return;
        }
        else {
            console.log(noText);
            this.error("Aborting");
            return;
        }
    };
    SoclessPackager.prototype.setupContainer = function () {
        var out = this.runProcess("docker", [
            "ps",
            "-a",
            "--filter",
            "name=".concat(this.config.containerName),
            "--format",
            "{{.Names}}",
        ]);
        out = out.replace(/^\s+|\s+$/g, "");
        if (out === this.config.containerName) {
            this.log("Container already exists. Killing it and reusing.");
            var out_1 = this.runProcess("docker", ["kill", "".concat(this.config.containerName)]);
            this.log(out_1);
        }
        var args = ["run", "--rm", "-dt", "-v", "".concat(process.cwd(), ":").concat(this.config.dockerServicePath)];
        // Add any environment variables to docker run cmd
        this.config.dockerEnvs.forEach(function (envVar) {
            args.push("-e", envVar);
        });
        if (this.config.mountSSH) {
            args = args.concat(["-v", "".concat(process.env.HOME, "/.ssh:/root/.ssh")]);
        }
        args = args.concat(["--name", this.config.containerName, this.config.dockerImage, "bash"]);
        this.runProcess("docker", args);
        this.log("Container created");
    };
    SoclessPackager.prototype.ensureImage = function () {
        var out = this.runProcess("docker", [
            "images",
            "--format",
            "{{.Repository}}:{{.Tag}}",
            "--filter",
            "reference=".concat(this.config.dockerImage),
        ]).replace(/^\s+|\s+$/g, "");
        if (out != this.config.dockerImage) {
            this.log("Docker Image ".concat(this.config.dockerImage, " is not already installed on your system. Downloading. This might take a while. Subsequent deploys will be faster..."));
            this.runProcess("docker", ["pull", this.config.dockerImage]);
        }
    };
    SoclessPackager.prototype.setupDocker = function () {
        if (!this.config.useDocker) {
            return;
        }
        this.log("Packaging using Docker container...");
        this.checkDocker();
        this.ensureImage();
        this.log("Creating Docker container \"".concat(this.config.containerName, "\"..."));
        this.setupContainer();
        this.log("Docker setup completed");
    };
    SoclessPackager.prototype.makePackage = function (target) {
        var _this = this;
        this.log("Packaging ".concat(target.name, "..."));
        var buildPath = path_1.default.join(this.config.buildDir, target.name);
        var requirementsPath = path_1.default.join(buildPath, this.config.requirementsFile);
        // Create package directory and package files
        fs_extra_1.default.ensureDirSync(buildPath);
        // Copy includes
        var includes = target.includes || [];
        includes = includes.concat(this.config.globalIncludes);
        includes.forEach(function (item) {
            if (fs_extra_1.default.existsSync(item)) {
                fs_extra_1.default.copySync(item, buildPath);
            }
        });
        // Install requirements
        var requirementsFiles = [requirementsPath];
        requirementsFiles = requirementsFiles.concat(this.config.globalRequirements);
        requirementsFiles.forEach(function (req) {
            if (fs_extra_1.default.existsSync(req)) {
                _this.installRequirements(buildPath, req);
            }
        });
        zip_local_1.default.sync.zip(buildPath).compress().save("".concat(buildPath, ".zip"));
    };
    return SoclessPackager;
}());
module.exports = SoclessPackager;
