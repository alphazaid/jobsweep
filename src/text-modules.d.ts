// Bun bundles `import x from "./file.md" with { type: "text" }` as a string, including into compiled binaries.
declare module "*.md" {
  const text: string
  export default text
}
