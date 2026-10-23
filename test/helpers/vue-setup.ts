// Exercise component state and watchers with Vue's real reactivity, without a browser or UI stubs.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compileScript, parse } from '@vue/compiler-sfc';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { effectScope, proxyRefs } from 'vue';

function moduleUrl(source: string, path: string): string {
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  }).outputText;
  const code = compiled.replace(/from ['"]([^'"]+)['"]/g, (_match: string, specifier: string) => {
    const url = specifier.endsWith('.vue')
      ? 'data:text/javascript,export default {}'
      : specifier.startsWith('.')
        ? moduleUrl(
            readFileSync(resolve(dirname(path), `${specifier}.ts`), 'utf8'),
            resolve(dirname(path), `${specifier}.ts`),
          )
        : import.meta.resolve(specifier);
    return `from ${JSON.stringify(url)}`;
  });
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}

/** Load a component's real script; callers supply reactive props and stop its watchers after the test. */
export async function componentSetup(path: string, props: unknown, emit = (_event: string, _value: unknown) => {}) {
  const absolute = resolve(path);
  const { descriptor } = parse(readFileSync(absolute, 'utf8'), { filename: absolute });
  const script = compileScript(descriptor, { id: path });
  const module = await import(moduleUrl(script.content, absolute));
  const scope = effectScope();
  const state = scope.run(() => module.default.setup(props, { expose: () => {}, emit }));
  return { state: proxyRefs(state as Record<string, any>), stop: () => scope.stop() };
}
