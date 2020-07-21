/**
 * @file CMake test adapter
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import {
  TestAdapter,
  TestLoadStartedEvent,
  TestLoadFinishedEvent,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  TestSuiteEvent,
  TestEvent,
  TestSuiteInfo,
  TestInfo,
  RetireEvent,
} from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { CmakeTestInfo } from './interfaces/cmake-test-info';
import { CmakeTestResult } from './interfaces/cmake-test-result';
import { CmakeTestProcess } from './interfaces/cmake-test-process';
import {
  loadCmakeTests,
  scheduleCmakeTest,
  executeCmakeTest,
  cancelCmakeTest,
  getCmakeTestDebugConfiguration,
  CacheNotFoundError,
  getCtestPath,
} from './cmake-runner';

/** Special ID value for the root suite */
const ROOT_SUITE_ID = '*';

/** Suffix for suites */
const SUITE_SUFFIX = '*';

/**
 * CMake test adapter for the Test Explorer UI extension
 */
export class CmakeAdapter implements TestAdapter {
  private disposables: { dispose(): void }[] = [];

  /** Discovered CTest command path */
  private ctestPath: string = '';

  /** Discovered CMake tests */
  private cmakeTests: CmakeTestInfo[] = [];

  /** State */
  private state: 'idle' | 'loading' | 'running' | 'cancelled' = 'idle';

  /** Currently running tests */
  private currentTestProcessList: {
    [id: string]: CmakeTestProcess
  } = {};

  /** Currently running tests */
  private runningTests: Promise<void>[] = [];

  /** Currently debugged test config */
  private debuggedTestConfig?: Partial<vscode.DebugConfiguration>;

  //
  // TestAdapter implementations
  //

  private readonly testsEmitter = new vscode.EventEmitter<
    TestLoadStartedEvent | TestLoadFinishedEvent
  >();
  private readonly testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
  private readonly autorunEmitter = new vscode.EventEmitter<void>();

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }
  get testStates(): vscode.Event<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  > {
    return this.testStatesEmitter.event;
  }
  get retire(): vscode.Event<RetireEvent> | undefined {
    return this.retireEmitter.event;
  }
  get autorun(): vscode.Event<void> | undefined {
    return this.autorunEmitter.event;
  }

  constructor(
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly log: Log,
    context: vscode.ExtensionContext
  ) {
    this.log.info('Initializing CMake test adapter');

    // Register a DebugConfigurationProvider to combine global and
    // test-specific debug configurations (see debugTest)
    context.subscriptions.push(
      vscode.debug.registerDebugConfigurationProvider('cppdbg', {
        resolveDebugConfiguration: (
          folder: vscode.WorkspaceFolder | undefined,
          config: vscode.DebugConfiguration,
          token?: vscode.CancellationToken
        ): vscode.ProviderResult<vscode.DebugConfiguration> => {
          return {
            ...config,
            ...this.debuggedTestConfig,
          };
        },
      })
    );

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.autorunEmitter);
  }

  async load(): Promise<void> {
    if (this.state !== 'idle') return; // it is safe to ignore a call to `load()`, even if it comes directly from the Test Explorer

    this.state = 'loading';
    this.log.info('Loading CMake tests');
    this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

    let buildDir;
    try {
      // Get & substitute config settings
      const config = vscode.workspace.getConfiguration(
        'cmakeExplorer',
        this.workspaceFolder.uri
      );
      const varMap = await this.getVariableSubstitutionMap();
      buildDir = await this.configGetStr(config, varMap, 'buildDir');
      const buildConfig = await this.configGetStr(
        config,
        varMap,
        'buildConfig'
      );
      const extraCtestLoadArgs = await this.configGetStr(
        config,
        varMap,
        'extraCtestLoadArgs'
      );
      const dir = path.resolve(this.workspaceFolder.uri.fsPath, buildDir);
      this.ctestPath = getCtestPath(dir);
      this.cmakeTests = await loadCmakeTests(
        this.ctestPath,
        dir,
        buildConfig,
        extraCtestLoadArgs
      );

      const rootSuite: TestSuiteInfo = {
        type: 'suite',
        id: ROOT_SUITE_ID,
        label: 'CMake', // the label of the root node should be the name of the testing framework
        children: [],
      };

      const delimiter = config.get<string>("suiteDelimiter");
      if (!delimiter) {
        for (let test of this.cmakeTests) {
          const testInfo: TestInfo = {
            type: 'test',
            id: test.name,
            label: test.name,
            tooltip: test.name
          };
          rootSuite.children.push(testInfo);
        }
      } else {
        for (let test of this.cmakeTests) {
          const path = test.name.split(delimiter);
          const testName = path.pop() || "undefined";
          let suite = rootSuite;
          let currentId = "";
          for (let name of path) {
            currentId += name + delimiter;
            let suit = suite.children.find((item) => item.type == 'suite' && item.id === currentId + SUITE_SUFFIX);
            if (!suit) {
              suit = {
                type: 'suite',
                id: currentId + SUITE_SUFFIX,
                label: name,
                children: [],
                tooltip: currentId.substr(0, currentId.length-delimiter.length)
              };
              suite.children.push(suit);
            }
            suite = suit as TestSuiteInfo;
          }
          const testInfo: TestInfo = {
            type: 'test',
            id: test.name,
            label: testName,
            description: test.name,
            tooltip: test.name
          };
          suite.children.push(testInfo);
        }
      }

      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        suite: rootSuite,
      });
    } catch (e) {
      if (e instanceof CacheNotFoundError && buildDir === '') {
        // Ignore error when using default config
        this.testsEmitter.fire(<TestLoadFinishedEvent>{
          type: 'finished',
        });
      } else {
        // Report error
        this.testsEmitter.fire(<TestLoadFinishedEvent>{
          type: 'finished',
          errorMessage: e.toString(),
        });
      }
    }

    this.state = 'idle';
  }

  async run(tests: string[]): Promise<void> {
    if (this.state !== 'idle') return; // it is safe to ignore a call to `run()`

    this.state = 'running';
    this.log.info(`Running CMake tests ${JSON.stringify(tests)}`);
    this.testStatesEmitter.fire(<TestRunStartedEvent>{
      type: 'started',
      tests,
    });

    try {
      for (const id of tests) {
        await this.runTest(id);
      }
    } catch (e) {
      // Fail silently
    }

    this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
    this.state = 'idle';
  }

  async debug(tests: string[]): Promise<void> {
    this.log.info(`Debugging CMake tests ${JSON.stringify(tests)}`);

    try {
      for (const id of tests) {
        await this.debugTest(id);
      }
    } catch (e) {
      // Fail silently
    }
  }

  cancel(): void {
    if (this.state !== 'running') return; // ignore

    for (const proc of Object.values(this.currentTestProcessList)) {
      cancelCmakeTest(proc)
    }

    // State will eventually transition to idle once the run loop completes
    this.state = 'cancelled';
  }

  dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Run a single test or test suite
   *
   * @param id Test or suite ID
   */
  private async runTest(id: string) {
    if (this.state === 'cancelled') {
      // Test run cancelled, retire test
      this.retireEmitter.fire(<RetireEvent>{ tests: [id] });
      return;
    }

    const config = vscode.workspace.getConfiguration(
      'cmakeExplorer',
      this.workspaceFolder.uri
    );

    const delimiter = config.get<string>("suiteDelimiter");

    if (id === ROOT_SUITE_ID || delimiter && (id.endsWith(delimiter + SUITE_SUFFIX))) {
      // Run the whole test suite

      let parallelJobs = config.get<number>("parallelJobs");
      if (!parallelJobs) {
        const cmakeConfig = vscode.workspace.getConfiguration(
          'cmake',
          this.workspaceFolder.uri
        );
        parallelJobs = cmakeConfig.get<number>("ctest.parallelJobs");
        if (!parallelJobs) {
          parallelJobs = cmakeConfig.get<number>("parallelJobs");
          if (!parallelJobs) {
            parallelJobs = os.cpus().length
          }
        }
      }
      if (parallelJobs < 1) parallelJobs = 1;

      this.testStatesEmitter.fire(<TestSuiteEvent>{
        type: 'suite',
        suite: id,
        state: 'running',
      });

      var suiteTests: CmakeTestInfo[];
      if (id === ROOT_SUITE_ID) {
        suiteTests = this.cmakeTests;
      } else {
        const prefix = id.substr(0, id.length - SUITE_SUFFIX.length);
        suiteTests = this.cmakeTests.filter((test) => test.name.startsWith(prefix));
      }

      const tests = [];
      for (const test of suiteTests) {
        const run = this.runTest(test.name);
        tests.push(run);
        const cleanup = () => this.runningTests.splice(this.runningTests.indexOf(running), 1);
        const running: any = run.catch(cleanup).then(cleanup);
        this.runningTests.push(running);
        while (this.runningTests.length >= parallelJobs) {
          await Promise.race(this.runningTests);
        }
      }
      await Promise.all(tests);

      this.testStatesEmitter.fire(<TestSuiteEvent>{
        type: 'suite',
        suite: id,
        state: 'completed',
      });

      return;
    }

    //
    // Single test
    //

    const test = this.cmakeTests.find((test) => test.name === id);
    if (!test) {
      // Not found, mark test as skipped.
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: id,
        state: 'skipped',
      });
      return;
    }

    // Run test
    this.testStatesEmitter.fire(<TestEvent>{
      type: 'test',
      test: id,
      state: 'running',
    });
    try {
      const varMap = await this.getVariableSubstitutionMap();
      const extraCtestRunArgs = await this.configGetStr(
        config,
        varMap,
        'extraCtestRunArgs'
      );
      this.currentTestProcessList[id] = scheduleCmakeTest(
        this.ctestPath,
        test,
        extraCtestRunArgs
      );
      const result: CmakeTestResult = await executeCmakeTest(
        this.currentTestProcessList[id]
      );
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: id,
        state: result.code ? 'failed' : 'passed',
        message: result.out,
      });
    } catch (e) {
      this.testStatesEmitter.fire(<TestEvent>{
        type: 'test',
        test: id,
        state: 'errored',
        message: e.toString(),
      });
    } finally {
      delete this.currentTestProcessList[id];
    }
  }

  /**
   * Debug a single test
   *
   * @param id Test ID
   */
  private async debugTest(id: string) {
    if (id === ROOT_SUITE_ID) {
      // Can't debug test suite.
      return;
    }

    //
    // Single test
    //

    const test = this.cmakeTests.find((test) => test.name === id);
    if (!test) {
      // Not found.
      return;
    }

    // Debug test
    this.log.info(`Debugging CMake test ${id}`);
    try {
      // Get test config
      const config = vscode.workspace.getConfiguration(
        'cmakeExplorer',
        this.workspaceFolder.uri
      );
      const delimiter = config.get<string>("suiteDelimiter");
      if (delimiter && (id.endsWith(delimiter + SUITE_SUFFIX))) {
        // Can't debug test suite.
        return;
      }
      const varMap = await this.getVariableSubstitutionMap();
      const debugConfig = await this.configGetStr(
        config,
        varMap,
        'debugConfig'
      );
      const defaultConfig: vscode.DebugConfiguration = {
        name: 'CTest',
        type: 'cppdbg',
        request: 'launch',
        windows: {
          type: 'cppvsdbg',
        },
        linux: {
          type: 'cppdbg',
          MIMode: 'gdb',
        },
        osx: {
          type: 'cppdbg',
          MIMode: 'lldb',
        },
      };

      // Remember test-specific config for the DebugConfigurationProvider registered
      // in the constructor (method resolveDebugConfiguration)
      this.debuggedTestConfig = getCmakeTestDebugConfiguration(test);

      // Start the debugging session. The actual debug config will combine the
      // global and test-specific values
      await vscode.debug.startDebugging(
        this.workspaceFolder,
        debugConfig || defaultConfig
      );
    } catch (e) {
      this.log.error(`Error debugging CMake test ${id}`, e.toString());
    } finally {
      this.debuggedTestConfig = undefined;
    }
  }

  /**
   * Get & substitute config settings
   *
   * @param config VS Code workspace configuration
   * @param varMap Variable to value map
   * @param key Config name
   */
  private async configGetStr(
    config: vscode.WorkspaceConfiguration,
    varMap: Map<string, string>,
    key: string
  ) {
    const configStr = config.get<string>(key) || '';
    let str = configStr;
    varMap.forEach((value, key) => {
      while (str.indexOf(key) > -1) {
        str = str.replace(key, value);
      }
    });
    return str;
  }

  /**
   * Get variable to value substitution map for config strings
   */
  private async getVariableSubstitutionMap() {
    // Standard variables
    const substitutionMap = new Map<string, string>([
      ['${workspaceFolder}', this.workspaceFolder.uri.fsPath],
    ]);

    // Variables from the CMake Tools extension
    for (const varname of ['buildType', 'buildDirectory']) {
      const command = `cmake.${varname}`;
      if ((await vscode.commands.getCommands()).includes(command)) {
        const value = (await vscode.commands.executeCommand(command)) as string;
        substitutionMap.set(`\${${varname}}`, value);
      }
    }
    return substitutionMap;
  }
}
