// Server side of the custom fields: processes, definition store and the record helper. Not importable from the browser.
export { CUSTOM_FIELD_PROCESSES, customFieldList, customFieldRemove, customFieldSet } from "./processes";
export { customData, visibleExtra } from "./record";
export type { CustomData } from "./record";
export { extraFree } from "./schemas";
export type { CustomFieldView } from "./schemas";
export { loadCustomFields } from "./store";
export type { CustomFieldRow } from "./store";
