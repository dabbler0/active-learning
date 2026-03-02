// Entry point for esbuild — re-exports everything editor.js needs
// from individual @codemirror packages (not the codemirror meta-package,
// to avoid duplicate-export errors).
export * from '@codemirror/state';
export * from '@codemirror/view';
export * from '@codemirror/commands';
export * from '@codemirror/language';
export * from '@codemirror/autocomplete';
export * from '@codemirror/search';
export * from '@codemirror/lang-markdown';
