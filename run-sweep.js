const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ==========================================
// SWEEP CONFIGURATION
// ==========================================

// SWEEP MODE:
// - 'one-at-a-time': Start with baseline, test each parameter variation in isolation (recommended).
// - 'grid': Test every possible combination of factors (Cartesian product).
// - 'manual': Run only the explicit configurations defined in SWEEP_RUNS.
const SWEEP_MODE = 'one-at-a-time';

// Define the values you want to sweep over for each hyperparameter.
// For 'one-at-a-time' mode, it will test each value listed here in isolation.
const SWEEP_FACTORS = {  
  'sequenceGenerator.meanLogSequenceLength': [2, 4],
  'sequenceGenerator.stdLogSequenceLength': [0.1, 0.3],
  
  'sequenceGenerator.meanLogTransitionProbability': [-1, -3],
  'sequenceGenerator.stdLogTransitionProbability': [0.15, 0.35],

  'sequenceGenerator.meanLogSessionLength': [1, 2.5],
  'sequenceGenerator.stdLogSessionLength': [0.25, 0.75],

  'sequenceGenerator.refinementPatternProbability': [0.05, 0.2],

  'sequenceGenerator.temperature': [0.025, 1.0]
};

// Paths
const RESULTS_DIR = path.join(__dirname, 'sweep-results');
const CONFIG_PATH = path.join(__dirname, 'input', 'config-queries.json');
const COMBINATIONS_DIR = path.join(__dirname, 'combinations');
const OUT_QUERIES_DIR = path.join(__dirname, 'generated', 'out-queries');

// Helper to set nested property on object using dot notation (e.g. 'sequenceGenerator.temperature')
function setNestedProperty(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

// Helper to get nested property from object using dot notation
function getNestedProperty(obj, path) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

// Helper to generate one-at-a-time sweep runs
function generateOneAtATimeRuns(factors, originalConfig) {
  const runs = [{}];
  
  for (const [key, values] of Object.entries(factors)) {
    const defaultValue = getNestedProperty(originalConfig, key);
    for (const value of values) {
      // Skip if value is same as default to avoid duplicate baseline runs
      if (value === defaultValue) {
        continue;
      }
      runs.push({ [key]: value });
    }
  }
  return runs;
}

// Helper to generate cartesian product of factors
function generateSweepCombinations(factors) {
  const keys = Object.keys(factors);
  if (keys.length === 0) return [{}];
  
  let combos = [{}];
  for (const key of keys) {
    const values = factors[key];
    const newCombos = [];
    for (const combo of combos) {
      for (const value of values) {
        newCombos.push({ ...combo, [key]: value });
      }
    }
    combos = newCombos;
  }
  return combos;
}

// Helper to copy directory recursively
function copyDirRecursive(src, dest) {
  if (typeof fs.cpSync === 'function') {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Helper to remove directory recursively
function removeDirRecursive(dirPath) {
  if (fs.existsSync(dirPath)) {
    if (typeof fs.rmSync === 'function') {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } else {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          removeDirRecursive(entryPath);
        } else {
          fs.unlinkSync(entryPath);
        }
      }
      fs.rmdirSync(dirPath);
    }
  }
}

// Helper to run a command as child process
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit', shell: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
  });
}

// Main execution flow
async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Error: Configuration file not found at ${CONFIG_PATH}`);
    process.exit(1);
  }

  // Save original config
  const originalConfigContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  let originalConfig;
  try {
    originalConfig = JSON.parse(originalConfigContent);
  } catch (e) {
    console.error(`Error: Failed to parse ${CONFIG_PATH} as JSON:`, e);
    process.exit(1);
  }

  // Cleanup handler to restore backup in case of interruption or crash
  let restored = false;
  function restoreBackupAndExit(exitCode = 0) {
    if (!restored) {
      console.log('\nRestoring original config-queries.json...');
      fs.writeFileSync(CONFIG_PATH, originalConfigContent, 'utf8');
      restored = true;
    }
    process.exit(exitCode);
  }

  process.on('SIGINT', () => restoreBackupAndExit(1));
  process.on('SIGTERM', () => restoreBackupAndExit(1));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    restoreBackupAndExit(1);
  });

  try {
    // Determine runs based on mode
    let runs;
    if (SWEEP_MODE === 'one-at-a-time') {
      runs = generateOneAtATimeRuns(SWEEP_FACTORS, originalConfig);
    } else if (SWEEP_MODE === 'grid') {
      runs = [{}, ...generateSweepCombinations(SWEEP_FACTORS)];
    } else {
      runs = [{}, ...SWEEP_RUNS];
    }

    // Deduplicate and normalize runs so we don't have duplicate baseline runs
    const uniqueRuns = [];
    const seenRuns = new Set();
    for (const run of runs) {
      // Normalize run by removing overrides that match original defaults
      const normalizedRun = {};
      for (const [key, value] of Object.entries(run)) {
        const defaultValue = getNestedProperty(originalConfig, key);
        if (value !== defaultValue) {
          normalizedRun[key] = value;
        }
      }
      
      const serialized = JSON.stringify(
        Object.keys(normalizedRun)
          .sort()
          .reduce((acc, k) => {
            acc[k] = normalizedRun[k];
            return acc;
          }, {})
      );
      
      if (!seenRuns.has(serialized)) {
        seenRuns.add(serialized);
        uniqueRuns.push(normalizedRun);
      }
    }
    runs = uniqueRuns;

    console.log(`Starting hyperparameter sweep (${SWEEP_MODE} mode). Total runs scheduled: ${runs.length}`);
    console.log(`Results will be stored in: ${RESULTS_DIR}\n`);

    // Ensure results folder exists
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    for (let i = 0; i < runs.length; i++) {
      const runParams = runs[i];
      const runIndex = i + 1;
      
      console.log(`=========================================`);
      console.log(`RUN ${runIndex} / ${runs.length}`);
      console.log(`Parameters:`, JSON.stringify(runParams, null, 2));
      console.log(`=========================================`);

      // Create new configuration object
      const currentConfig = JSON.parse(originalConfigContent);
      for (const [key, value] of Object.entries(runParams)) {
        setNestedProperty(currentConfig, key, value);
      }

      // Write new config to file
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');

      // Clean the queries directory to force regeneration with new parameters
      console.log(`\nCleaning queries directory: ${OUT_QUERIES_DIR}`);
      removeDirRecursive(OUT_QUERIES_DIR);

      // Prepare the experiment
      console.log('\nPreparing experiment (npm run jbr -- prepare)...');
      const prepStart = Date.now();
      await runCommand('npm', ['run', 'jbr', '--', 'prepare']);
      const prepDurationSec = ((Date.now() - prepStart) / 1000).toFixed(2);
      console.log(`Preparation complete in ${prepDurationSec}s.`);

      // Run the experiment
      console.log('\nRunning experiment (npm run jbr -- run)...');
      const runStart = Date.now();
      await runCommand('npm', ['run', 'jbr', '--', 'run']);
      const runDurationSec = ((Date.now() - runStart) / 1000).toFixed(2);
      console.log(`Experiment run complete in ${runDurationSec}s.`);

      // Record outputs
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      
      // Create a descriptive folder name based on the params
      let paramStr = 'baseline';
      if (Object.keys(runParams).length > 0) {
        paramStr = Object.entries(runParams)
          .map(([k, v]) => `${k.split('.').pop()}_${v}`)
          .join('-');
      }
      const runDirName = `run_${runIndex}_${paramStr}_${timestamp}`;
      const destRunDir = path.join(RESULTS_DIR, runDirName);

      console.log(`\nRecording experiment outputs to ${destRunDir}...`);
      fs.mkdirSync(destRunDir, { recursive: true });

      // Save the combinations folder
      if (fs.existsSync(COMBINATIONS_DIR)) {
        copyDirRecursive(COMBINATIONS_DIR, path.join(destRunDir, 'combinations'));
      } else {
        console.warn(`Warning: Combinations directory not found at ${COMBINATIONS_DIR}`);
      }

      // Save the generated queries
      if (fs.existsSync(OUT_QUERIES_DIR)) {
        console.log(`Saving generated queries from ${OUT_QUERIES_DIR}...`);
        copyDirRecursive(OUT_QUERIES_DIR, path.join(destRunDir, 'generated', 'out-queries'));
      } else {
        console.warn(`Warning: Queries directory not found at ${OUT_QUERIES_DIR}`);
      }

      // Save tested hyperparameters and metadata
      const metadata = {
        runIndex,
        timestamp: new Date().toISOString(),
        hyperparameters: runParams,
        durations: {
          prepareSeconds: parseFloat(prepDurationSec),
          runSeconds: parseFloat(runDurationSec)
        }
      };
      fs.writeFileSync(
        path.join(destRunDir, 'sweep_metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );
      
      // Also save the specific config-queries.json that was used
      fs.writeFileSync(
        path.join(destRunDir, 'config-queries.json'),
        JSON.stringify(currentConfig, null, 2),
        'utf8'
      );

      console.log(`Run ${runIndex} successfully completed and recorded.\n`);
    }

    console.log('All sweep runs completed successfully.');
    restoreBackupAndExit(0);
  } catch (error) {
    console.error('\nAn error occurred during the sweep:', error);
    restoreBackupAndExit(1);
  }
}

main();
