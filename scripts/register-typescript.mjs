import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.md?raw')) {
      const file = new URL(url);
      file.search = '';
      return {
        format: 'module',
        source: `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`,
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.'))
        for (const suffix of ['.ts', '/index.ts'])
          try {
            return next(specifier + suffix, context);
          } catch {}
      throw error;
    }
  },
});
