// raw view templates, see esbuild's --loader:.html=text in package.json
declare module "*.html" {
	const contents: string;
	export default contents;
}
// raw SVG markup, see --loader:.svg=text and icons.ts
declare module "*.svg" {
	const contents: string;
	export default contents;
}
