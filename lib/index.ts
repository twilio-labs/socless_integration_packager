"use strict";

import BbPromise from "bluebird";
import _ from "lodash";
import Fse from "fs-extra";
import Path from "path";
import ChildProcess from "child_process";
import zipper from "zip-local";
import upath from "upath";
import readlineSync from "readline-sync";
import Serverless from "serverless";

BbPromise.promisifyAll(Fse);

const FULL_PLUGIN_NAME = "socless_integration_packager";

interface PluginConfig {
  buildDir: string;
  requirementsFile: string;
  globalRequirements: string[];
  globalIncludes: string[];
  cleanup: boolean;
  useDocker: boolean;
  dockerImage: string;
  containerName: string;
  mountSSH: boolean;
  dockerEnvs: string[];
  abortOnPackagingErrors: boolean;
  dockerServicePath: string;
}

class SoclessPackager {
  serverless: Serverless;
  options: Serverless.Options;
  hooks: { [key: string]: Function };
  log: (msg: string) => void;
  error: (msg: string) => void;
  config: PluginConfig;
  // serverless: Serverless.Instance;
  // commands: Serverless.CommandsDefinition;

  constructor(serverless: Serverless, options: Serverless.Options) {
    this.serverless = serverless;
    this.options = options;
    this.log = (msg) => {
      this.serverless.cli.log(`[${FULL_PLUGIN_NAME}] ${msg}`);
    };
    this.error = (msg) => {
      throw new Error(`[${FULL_PLUGIN_NAME}] ${msg}`);
    };
    this.config = this.buildConfig();

    this.hooks = {
      "before:package:createDeploymentArtifacts": () =>
        BbPromise.bind(this)
          .then(this.buildConfig)
          .then(this.autoconfigArtifacts)
          .then(() => {
            Fse.ensureDir(this.config.buildDir);
          })
          .then(this.setupDocker)
          .then(this.selectAll)
          .map(this.makePackage),

      "after:deploy:deploy": () => BbPromise.bind(this).then(this.clean),
    };
  }

  buildConfig(): PluginConfig {
    if (!this.serverless.service.custom) {
      this.error("No serverless custom configurations are defined");
    }

    const custom = this.serverless.service.custom.soclessPackager;

    if (!custom) {
      this.error(`No ${FULL_PLUGIN_NAME} configuration detected. Please see documentation`);
    }
    let globalRequirements = custom.globalRequirements || ["./functions/requirements.txt"];
    if (!Array.isArray(globalRequirements)) {
      globalRequirements = [globalRequirements];
    }

    let globalIncludes = custom.globalIncludes || ["./common_files"];
    if (!Array.isArray(globalIncludes)) {
      globalIncludes = [globalIncludes];
    }

    const config = {
      buildDir: custom.buildDir || this.error("No buildDir configuration specified"),
      requirementsFile: custom.requirementsFile || "requirements.txt",
      globalRequirements,
      globalIncludes,
      cleanup: custom.cleanup === undefined ? true : custom.cleanup,
      useDocker: custom.useDocker === undefined ? true : custom.useDocker,
      dockerImage:
        custom.dockerImage || `lambci/lambda:build-${this.serverless.service.provider.runtime}`,
      containerName: custom.containerName || FULL_PLUGIN_NAME,
      mountSSH: custom.mountSSH === undefined ? false : custom.mountSSH,
      dockerEnvs: custom.dockerEnvs || [],
      abortOnPackagingErrors:
        custom.abortOnPackagingErrors === undefined ? true : custom.abortOnPackagingErrors,
      dockerServicePath: "/var/task",
    };

    this.config = config;
    return config;
  }

  autoconfigArtifacts() {
    // TODO: confirm these two functions have the same effect
    Object.entries(this.serverless.service.functions).map(([slsFuncName, funcConfig]) => {
      const autoArtifact = `${this.config.buildDir}/${funcConfig.name}.zip`;
      funcConfig.package = funcConfig.package || {};
      funcConfig.package.artifact = funcConfig.package.artifact || autoArtifact;
      this.serverless.service.functions[slsFuncName] = funcConfig;
    });
    // _.map(this.serverless.service.functions, (func_config, func_name) => {
    //   let autoArtifact = `${this.config.buildDir}/${func_config.name}.zip`;
    //   func_config.package.artifact = func_config.package.artifact || autoArtifact;
    //   this.serverless.service.functions[func_name] = func_config;
    // });
  }

  clean() {
    if (!this.config.cleanup) {
      this.log(
        'Cleanup is set to "false". Build directory and Docker container (if used) will be retained'
      );
      return false;
    }
    this.log("Cleaning build directory...");
    Fse.remove(this.config.buildDir).catch((err) => {
      this.log(err);
    });

    if (this.config.useDocker) {
      this.log("Removing Docker container...");
      this.runProcess("docker", ["stop", this.config.containerName, "-t", "0"]);
    }
    return true;
  }

  selectAll() {
    // TODO: confirm these two functions have the same outcome. TS did not like the first one (written in olddd JS)
    // const functions = _.reject(this.serverless.service.functions, (target) => {
    //   return target.runtime && !(target.runtime + "").match(/python/i);
    // });

    const functions = Object.values(this.serverless.service.functions).filter((target) => {
      return target.runtime !== undefined && target.runtime.includes("python");
    });

    const info = functions.map((target) => {
      const tgtPackage = target.package || {};
      return {
        name: target.name,
        // TODO: `include` is deprecated, move to `patterns`
        includes: tgtPackage.include,
        artifact: tgtPackage.artifact,
      };
    });
    return info;
  }

  installRequirements(buildPath, requirementsPath) {
    if (!Fse.pathExistsSync(requirementsPath)) {
      return;
    }
    const size = Fse.statSync(requirementsPath).size;

    if (size === 0) {
      this.log(`WARNING: requirements file at ${requirementsPath} is empty. Skiping.`);
      return;
    }

    let cmd = "pip";
    let args = ["install", "--upgrade", "-t", upath.normalize(buildPath), "-r"];
    if (this.config.useDocker === true) {
      cmd = "docker";
      args = ["exec", this.config.containerName, "pip", ...args];
      requirementsPath = `${this.config.dockerServicePath}/${requirementsPath}`;
    }

    args = [...args, upath.normalize(requirementsPath)];
    return this.runProcess(cmd, args);
  }

  checkDocker() {
    const out = this.runProcess("docker", [
      "version",
      "-f",
      "Server Version {{.Server.Version}} & Client Version {{.Client.Version}}",
    ]);
    this.log(`Using Docker ${out}`);
  }

  runProcess(cmd, args) {
    const ret = ChildProcess.spawnSync(cmd, args);
    if (ret.error) {
      this.error(ret.error.message);
    }

    const out = ret.stdout.toString();

    if (ret.stderr.length != 0) {
      const errorText = ret.stderr.toString().trim();
      this.log(errorText); // prints stderr

      if (this.config.abortOnPackagingErrors) {
        const countErrorNewLines = errorText.split("\n").length;

        if (
          !errorText.includes("ERROR:") &&
          ((countErrorNewLines < 2 && errorText.toLowerCase().includes("git clone")) ||
            (countErrorNewLines < 3 && errorText.toLowerCase().includes("git checkout")))
        ) {
          // Ignore false positive due to pip git clone printing to stderr
        } else if (
          errorText.toLowerCase().includes("warning") &&
          !errorText.toLowerCase().includes("error")
        ) {
          // Ignore warnings
        } else if (errorText.toLowerCase().includes("docker")) {
          console.log("stdout:", out);
          this.error("Docker Error Detected");
        } else {
          // Error is not false positive,
          console.log("___ERROR DETECTED, BEGIN STDOUT____\n", out);
          this.requestUserConfirmation();
        }
      }
    }

    return out;
  }

  requestUserConfirmation(
    prompt = "\n\n??? Do you wish to continue deployment with the stated errors? \n",
    yesText = "Continuing Deployment!",
    noText = "ABORTING DEPLOYMENT"
  ) {
    const response = readlineSync.question(prompt);
    if (response.toLowerCase().includes("y")) {
      console.log(yesText);
      return;
    } else {
      console.log(noText);
      this.error("Aborting");
      return;
    }
  }

  setupContainer() {
    let out = this.runProcess("docker", [
      "ps",
      "-a",
      "--filter",
      `name=${this.config.containerName}`,
      "--format",
      "{{.Names}}",
    ]);
    out = out.replace(/^\s+|\s+$/g, "");

    if (out === this.config.containerName) {
      this.log("Container already exists. Killing it and reusing.");
      let out = this.runProcess("docker", ["kill", `${this.config.containerName}`]);
      this.log(out);
    }

    let args = ["run", "--rm", "-dt", "-v", `${process.cwd()}:${this.config.dockerServicePath}`];

    // Add any environment variables to docker run cmd
    this.config.dockerEnvs.forEach(function (envVar) {
      args.push("-e", envVar);
    });

    if (this.config.mountSSH) {
      args = args.concat(["-v", `${process.env.HOME}/.ssh:/root/.ssh`]);
    }

    args = args.concat(["--name", this.config.containerName, this.config.dockerImage, "bash"]);
    this.runProcess("docker", args);
    this.log("Container created");
  }

  ensureImage() {
    const out = this.runProcess("docker", [
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
      "--filter",
      `reference=${this.config.dockerImage}`,
    ]).replace(/^\s+|\s+$/g, "");
    if (out != this.config.dockerImage) {
      this.log(
        `Docker Image ${this.config.dockerImage} is not already installed on your system. Downloading. This might take a while. Subsequent deploys will be faster...`
      );
      this.runProcess("docker", ["pull", this.config.dockerImage]);
    }
  }

  setupDocker() {
    if (!this.config.useDocker) {
      return;
    }
    this.log("Packaging using Docker container...");
    this.checkDocker();
    this.ensureImage();
    this.log(`Creating Docker container "${this.config.containerName}"...`);
    this.setupContainer();
    this.log("Docker setup completed");
  }

  makePackage(target) {
    this.log(`Packaging ${target.name}...`);
    const buildPath = Path.join(this.config.buildDir, target.name);
    const requirementsPath = Path.join(buildPath, this.config.requirementsFile);
    // Create package directory and package files
    Fse.ensureDirSync(buildPath);
    // Copy includes
    let includes = target.includes || [];
    includes = includes.concat(this.config.globalIncludes);

    includes.forEach((item) => {
      if (Fse.existsSync(item)) {
        Fse.copySync(item, buildPath);
      }
    });

    // Install requirements
    let requirementsFiles = [requirementsPath];
    requirementsFiles = requirementsFiles.concat(this.config.globalRequirements);

    requirementsFiles.forEach((req) => {
      if (Fse.existsSync(req)) {
        this.installRequirements(buildPath, req);
      }
    });
    zipper.sync.zip(buildPath).compress().save(`${buildPath}.zip`);
  }
}

module.exports = SoclessPackager;
