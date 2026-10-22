// Lets plain TypeScript (the linter's type checker) see .vue imports; vue-tsc reads the files themselves.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
