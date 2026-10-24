import path from 'node:path';

// Both the server and maintenance commands use this project's environment.
export function pythonExecutable(root: string, platform: NodeJS.Platform = process.platform) {
  return platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
}

export function pythonEnvironment() {
  // Swiss Ephemeris uses native narrow paths on Windows. With cwd fixed to
  // the project, this ASCII path also works when the absolute root is Cyrillic.
  return { ...process.env, PYTHONUTF8: '1', SE_EPHE_PATH: 'data/ephe' };
}
