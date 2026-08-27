import { registerVideoTools } from "./tools.js";
export const name = 'dsh-video-frames';
export const inject = ['tools'];
export function apply(ctx) {
    registerVideoTools(ctx);
}
