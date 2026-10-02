/** CSS Modules resolve to their generated class-name map. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
