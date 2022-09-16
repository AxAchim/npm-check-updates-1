import globby from 'globby'
import isString from 'lodash/isString'
import path from 'path'
import prompts from 'prompts-ncu'
import spawn from 'spawn-please'
import untildify from 'untildify'
import { cliOptionsMap } from './cli-options'
import chalk, { chalkInit } from './lib/chalk'
import doctor from './lib/doctor'
import exists from './lib/exists'
import findPackage from './lib/findPackage'
import getNcuRc from './lib/getNcuRc'
import getPackageFileName from './lib/getPackageFileName'
import initOptions from './lib/initOptions'
import { print, printJson } from './lib/logging'
import mergeOptions from './lib/mergeOptions'
import programError from './lib/programError'
import runGlobal from './lib/runGlobal'
import runLocal from './lib/runLocal'
import packageManagers from './package-managers'
import { Index } from './types/IndexType'
import { Options } from './types/Options'
import { PackageFile } from './types/PackageFile'
import { RunOptions } from './types/RunOptions'
import { VersionSpec } from './types/VersionSpec'

// allow prompt injection from environment variable for testing purposes
if (process.env.INJECT_PROMPTS) {
  prompts.inject(JSON.parse(process.env.INJECT_PROMPTS))
}

// exit with non-zero error code when there is an unhandled promise rejection
process.on('unhandledRejection', err => {
  throw err
})

/**
 * Volta is a tool for managing JavaScript tooling like Node and npm. Volta has
 * its own system for installing global packages which circumvents npm, so
 * commands like `npm ls -g` do not accurately reflect what is installed.
 *
 * The ability to use `npm ls -g` is tracked in this Volta issue: https://github.com/volta-cli/volta/issues/1012
 */
function checkIfVolta(options: Options): void {
  // The first check is for macOS/Linux and the second check is for Windows
  if (options.global && (!!process.env.VOLTA_HOME || process.env.PATH?.includes('\\Volta'))) {
    const message =
      'It appears you are using Volta. `npm-check-updates --global` ' +
      'cannot be used with Volta because Volta has its own system for ' +
      'managing global packages which circumvents npm.\n\n' +
      'If you are still receiving this message after uninstalling Volta, ' +
      'ensure your PATH does not contain an entry for Volta and your ' +
      'shell profile does not define VOLTA_HOME. You may need to reboot ' +
      'for changes to your shell profile to take effect.'

    print(options, message, 'error')
    process.exit(1)
  }
}

/** Returns the package manager that should be used to install packages after running "ncu -u". Detects pnpm via pnpm-lock.yarn. This is the one place that pnpm needs to be detected, since otherwise it is backwards compatible with npm. */
const getPackageManagerForInstall = async (options: Options, pkgFile: string) => {
  if (options.packageManager === 'yarn') return 'yarn'
  const cwd = options.cwd ?? pkgFile ? `${pkgFile}/..` : process.cwd()
  const pnpmLockFile = path.join(cwd, 'pnpm-lock.yaml')
  const pnpm = await exists(pnpmLockFile)
  return pnpm ? 'pnpm' : 'npm'
}

/** Either suggest an install command based on the package manager, or in interactive mode, prompt to autoinstall. */
const npmInstallHint = async (
  pkgs: string[],
  analysis: Index<PackageFile> | PackageFile,
  options: Options,
): Promise<unknown> => {
  // if no packages were upgraded (i.e. all dependendencies deselected in interactive mode), then bail without suggesting an install.
  // normalize the analysis for one or many packages
  const analysisNormalized =
    pkgs.length === 1 ? { [pkgs[0]]: analysis as PackageFile } : (analysis as Index<PackageFile>)
  const someUpgraded = Object.values(analysisNormalized).some(upgrades => Object.keys(upgrades).length > 0)
  if (!someUpgraded) return

  let showInstallHint = true

  // for the purpose of the install hint, just use the package manager used in the first subproject
  // if autoinstalling, the actual package manager in each subproject will be used
  const packageManager = await getPackageManagerForInstall(options, pkgs[0])

  // by default, show an install hint after upgrading
  // this will be disabled in interactive mode if the user chooses to have npm-check-updates execute the install command
  const installHint = `${chalk.cyan(packageManager + ' install')}${
    pkgs.length > 1 ? ' in each project directory' : ''
  } to install new versions`

  // prompt the user if they want ncu to run "npm install"
  if (options.interactive) {
    console.info('')
    const response = await prompts({
      type: 'confirm',
      name: 'value',
      message: `${installHint}?`,
      initial: true,
      // allow Ctrl+C to kill the process
      onState: (state: any) => {
        if (state.aborted) {
          process.nextTick(() => process.exit(1))
        }
      },
    })

    // autoinstall
    if (response.value) {
      showInstallHint = false
      pkgs.forEach(async pkgFile => {
        const packageManager = await getPackageManagerForInstall(options, pkgFile)
        const cmd = packageManager + (process.platform === 'win32' ? '.cmd' : '')
        const cwd = options.cwd || path.resolve(pkgFile, '..')
        const stdout = await spawn(cmd, ['install'], { cwd })
        print(options, stdout, 'verbose')
      })
    }
  }

  // show the install hint unless autoinstall occurred
  if (showInstallHint) {
    print(options, `\nRun ${installHint}.`)
  }
}

/** Main entry point.
 *
 * @returns Promise<
 * PackageFile                    Default returns upgraded package file.
 * | Index<VersionSpec>    --jsonUpgraded returns only upgraded dependencies.
 * | void                         --global upgrade returns void.
 * >
 */
export async function run(
  runOptions: RunOptions = {},
  { cli }: { cli?: boolean } = {},
): Promise<PackageFile | Index<VersionSpec> | void> {
  const options = await initOptions(runOptions, { cli })

  // chalk may already have been intialized in cli.ts, but when imported as a module
  // chalkInit is idempotent
  await chalkInit(options.color)

  checkIfVolta(options)

  print(options, 'Initializing', 'verbose')

  if (options.packageManager === 'npm' && !options.prefix) {
    options.prefix = await packageManagers.npm.defaultPrefix!(options)
  }

  if (options.packageManager === 'yarn' && !options.prefix) {
    options.prefix = await packageManagers.yarn.defaultPrefix!(options)
  }

  let timeout: NodeJS.Timeout
  let timeoutPromise: Promise<void> = new Promise(() => null)
  if (options.timeout) {
    const timeoutMs = isString(options.timeout) ? Number.parseInt(options.timeout, 10) : options.timeout
    timeoutPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        // must catch the error and reject explicitly since we are in a setTimeout
        const error = `Exceeded global timeout of ${timeoutMs}ms`
        reject(error)
        try {
          programError(options, chalk.red(error))
        } catch (e) {
          /* noop */
        }
      }, timeoutMs)
    })
  }

  /** Runs the dependency upgrades. Loads the ncurc, finds the package file, and handles --deep. */
  async function runUpgrades(): Promise<Index<string> | PackageFile | void> {
    const defaultPackageFilename = getPackageFileName(options)
    let pkgs = globby.sync(
      options.cwd
        ? untildify(defaultPackageFilename).replace(/\\/g, '/') // convert Windows path to *nix path for globby
        : defaultPackageFilename,
      {
        ignore: ['**/node_modules/**'],
      },
    )

    // --workspace
    if (options.workspace?.length) {
      const [pkgData] = await findPackage({ ...options, packageFile: defaultPackageFilename })
      const workspaces = (typeof pkgData === 'string' ? (JSON.parse(pkgData) as PackageFile) : (pkgData as PackageFile))
        .workspaces
      if (!workspaces) {
        programError(
          options,
          chalk.red(
            'workspaces property missing from package.json. --workspace only works when you specify a "workspaces" property in your package.json.',
          ),
        )
      }
      const workspacePackageGlob = ([] as string[])
        .concat(workspaces || [])
        .map(workspace => path.join(workspace, defaultPackageFilename))
      pkgs = globby
        .sync(workspacePackageGlob, {
          ignore: ['**/node_modules/**'],
        })
        .filter(pkgFile =>
          options.workspace!.some(workspace =>
            workspaces?.some(
              workspacePattern =>
                pkgFile === path.join(path.dirname(workspacePattern), workspace, defaultPackageFilename),
            ),
          ),
        )
    }
    // --workspaces and --withWorkspaces
    else if (options.workspaces || options.withWorkspaces) {
      const [pkgData] = await findPackage({ ...options, packageFile: defaultPackageFilename })
      const workspaces = (typeof pkgData === 'string' ? (JSON.parse(pkgData) as PackageFile) : (pkgData as PackageFile))
        .workspaces
      if (!workspaces) {
        programError(
          options,
          chalk.red(
            `workspaces property missing from package.json. --${
              options.withWorkspaces ? 'withWorkspaces' : 'workspaces'
            } only works when you specify a "workspaces" property in your package.json.`,
          ),
        )
      }
      const workspacePackageGlob = ([] as string[])
        .concat(workspaces || [])
        .map(workspace => path.join(workspace, defaultPackageFilename))
      pkgs = [
        // include root project package file when --withWorkspaces is used
        ...(options.withWorkspaces ? pkgs : []),
        ...globby.sync(workspacePackageGlob, {
          ignore: ['**/node_modules/**'],
        }),
      ]
    }

    // enable --deep if multiple package files are found
    options.deep =
      options.deep || options.withWorkspaces || options.workspaces || !!options.workspace || pkgs.length > 1

    let analysis: Index<PackageFile> | PackageFile | void
    if (options.global) {
      const analysis = await runGlobal(options)
      clearTimeout(timeout)
      return analysis
    } else if (options.deep) {
      analysis = await pkgs.reduce(async (previousPromise, packageFile) => {
        const packages = await previousPromise
        // copy object to prevent share .ncurc options between different packageFile, to prevent unpredictable behavior
        const rcResult = await getNcuRc({ packageFile, color: options.color })
        let rcConfig = rcResult && rcResult.config ? rcResult.config : {}
        if (options.mergeConfig && Object.keys(rcConfig).length) {
          // Merge config options.
          rcConfig = mergeOptions(options, rcConfig)
        }
        const pkgOptions = {
          ...options,
          ...rcConfig,
          packageFile,
        }
        const [pkgData, pkgFile] = await findPackage(pkgOptions)
        return {
          ...packages,
          // index by relative path if cwd was specified
          [pkgOptions.cwd
            ? path
                .relative(path.resolve(pkgOptions.cwd), pkgFile!)
                // convert Windows path to *nix path for consistency
                .replace(/\\/g, '/')
            : pkgFile!]: await runLocal(pkgOptions, pkgData, pkgFile),
        }
      }, Promise.resolve({} as Index<PackageFile> | PackageFile))
      if (options.json) {
        printJson(options, analysis)
      }
    } else {
      // Mutate packageFile when glob patern finds only single package
      if (pkgs.length === 1 && pkgs[0] !== defaultPackageFilename) {
        options.packageFile = pkgs[0]
      }
      const [pkgData, pkgFile] = await findPackage(options)
      analysis = await runLocal(options, pkgData, pkgFile)
    }
    clearTimeout(timeout)

    // suggest install command or autoinstall
    if (options.upgrade) {
      await npmInstallHint(pkgs, analysis, options)
    }

    return analysis
  }

  // doctor mode
  if (options.doctor) {
    // execute with -u
    if (options.upgrade) {
      // we have to pass run directly since it would be a circular require if doctor included this file
      return Promise.race([timeoutPromise, doctor(run, options)])
    }
    // print help otherwise
    else {
      print(options, `Usage: ncu --doctor\n\n${(cliOptionsMap.doctor.help as () => string)()}`, 'warn')
    }
  }
  // normal mode
  else {
    return Promise.race([timeoutPromise, runUpgrades()])
  }
}

export default run

export type { RunOptions }
