// @moduleResolution: baseUrl
// @module: commonjs
// @baseUrl: c:/root

// user defined base url

// @filename: c:/root/folder1/file1.ts
import {x} from "folder2/file2"

declare function use(a: any): void;

use(x.toExponential());

// @filename: c:/root/folder2/file2.ts
export {x} from "./file3"

// @filename: c:/root/folder2/file3.ts
export var x = 1;