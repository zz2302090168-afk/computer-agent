import { registerHooks } from 'node:module';
registerHooks({
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
await import('../backend/tests/core.test.ts');
