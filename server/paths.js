import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIRS = {
  root: ROOT,
  output: path.join(ROOT, 'output'),
  cache: path.join(ROOT, 'cache'),
  input: path.join(ROOT, 'input'),
  presets: path.join(ROOT, 'presets'),
  scripts: path.join(ROOT, 'scripts'),
  assets: path.join(ROOT, 'assets'),
  public: path.join(ROOT, 'public'),
};
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const APP_TITLE = '플레이리스트 팩토리';
