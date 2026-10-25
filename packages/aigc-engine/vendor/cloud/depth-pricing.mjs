import { operationPlan } from "./access.mjs";
export const depthQuote = (data, user) => operationPlan(data, user.id, "depth");
