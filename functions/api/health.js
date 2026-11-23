import { handleApiRequest } from "../_lib/relay.js";
export function onRequest(context) { return handleApiRequest(context.request, context.env); }
