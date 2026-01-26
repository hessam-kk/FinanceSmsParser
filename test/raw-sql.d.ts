/** Vite ?raw import support for tests (migration SQL + PEM fixtures). */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "*.pem?raw" {
  const content: string;
  export default content;
}