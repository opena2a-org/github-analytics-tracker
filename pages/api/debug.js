const path = require('path');
const fs = require('fs');

export default function handler(req, res) {
  const cwd = process.cwd();
  const dirname = __dirname;
  const dbPathCwd = path.join(cwd, 'data', 'analytics.db');
  const dbPathDir = path.join(dirname, '..', '..', 'data', 'analytics.db');

  const checks = {
    cwd,
    dirname,
    dbPathCwd,
    dbPathDir,
    cwdExists: fs.existsSync(dbPathCwd),
    dirExists: fs.existsSync(dbPathDir),
    cwdDataDir: fs.existsSync(path.join(cwd, 'data')),
    dirDataDir: fs.existsSync(path.join(dirname, '..', '..', 'data')),
  };

  // List files in cwd
  try {
    checks.cwdFiles = fs.readdirSync(cwd);
  } catch (e) {
    checks.cwdFilesError = e.message;
  }

  // List files in data dir if it exists
  try {
    checks.dataFiles = fs.readdirSync(path.join(cwd, 'data'));
  } catch (e) {
    checks.dataFilesError = e.message;
  }

  res.status(200).json(checks);
}
