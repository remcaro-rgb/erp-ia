import "./zod-locale";

export const KERNEL_VERSION = "0.1.0";
export { writeAudit, setAuditContext } from "./audit/audit";
export { AUDIT_ACTIONS, AUDIT_FEATURE, AUDIT_ORIGINS, AUDIT_PROCESSES, auditConsult, auditEntity } from "./audit/viewer";
export type { AuditAction, AuditContext, AuditEntry, Origin } from "./audit/audit";
export { USER_PROCESSES, USERS_FEATURE, userConsult, userEntity } from "./users/entity";
export { adminUserMfaSet, adminUserPasswordReset, USER_MFA_PROCESSES, userMfaDisable, userPasswordChange } from "./users/mfa";
export { membershipInactive } from "./users/membership";
export { hasVerifiedFactor, revokeUserSessions } from "./users/sessions";
export { auditEntityOf, auditEntryDetail, auditEntryRead, describeAuditEntry, readAuditEntry } from "./audit/detail";
export type { AuditEntryDetail, AuditEntrySummary, AuditFieldChange, AuditInputValue, AuditRecord } from "./audit/detail";
export { countryPackOf, fieldOfKey, registerCatalogue, translatorFor, valueText } from "./registry/labels";
export type { Catalogue, LabelledField, Translate, ValueLabels } from "./registry/labels";
export { recordTitles } from "./records/titles";
export type { RecordRef } from "./records/titles";
export { cloneDraft, draftValues } from "./records/clone";
export { enqueueEvent } from "./events/outbox";
export type { OutboxEvent } from "./events/outbox";
export { buildConsumerContext, consumers, ConsumerRegistry, SYSTEM_USER_ID } from "./events/consumers";
export type { JwtClaims, Tx } from "./db/client";
export { withClaims } from "./db/client";
export { getServiceDb } from "./db/service";
export { defineEntity, hasRecordPage, recordHref, recordPageEntities, Registry, registry, USER_ENTITY } from "./registry";
export type { ConsumerContext, EntityDef, EntityType, Chart, EventConsumer, FeatureDef, FieldDef, FieldType, HomeChartProvider, HomeKpiProvider, Kpi, MenuSection, ModuleDef, NavItem, PrintVariables, ProcessDef, ProcessKind, RecordTabContribution, ResolvedEntityDef, ResolvedFieldDef, TypedDef } from "./registry";
export { maskedViewSql } from "./security/masked-views";
export { defineProcess } from "./process/define";
export { assertRecordRight, recordGuardOf, runProcess, uncoveredRecordWrites } from "./process/run";
export type { RecordRight } from "./process/run";
export { DEFAULT_NESTED_DEPTH, ledgerOrStockEvent, ledgerOrStockReason, NESTED_HARD_MAX, NESTED_RETRY_PROCESS, nestedPolicy } from "./process/nested-policy";
export type { NestedPolicy } from "./process/nested-policy";
export type { RunProcessDeps, RunProcessOptions } from "./process/run";
export { isMembershipInactive, MEMBERSHIP_INACTIVE, ProcessError } from "./process/errors";
export type { ProcessErrorCode, ProcessErrorStage } from "./process/errors";
export type { Caller, ProcessContext } from "./process/context";
export { defineModule, flattenNav } from "./module/define";
export { loadModules } from "./module/loader";
export { KERNEL_PARAMETER_PAGES, MENU_SECTIONS, menuItemsOf, menuSections, uncoveredMenuProcesses, withMenuSections } from "./module/menu";
export type { MenuItemRow, ParameterPage } from "./module/menu";
export { menuHiddenKeys, menuPathAllowed } from "./typed";
export type { MenuAccessRule } from "./typed";
export { entitled, entitlementLimit, enableModule, disableModule, gateOf, moduleGate, replayParkedEvents, syncModuleManifest, syncModuleManifestIfChanged } from "./entitlements/resolver";
export type { EntitledFn, ModuleGate } from "./entitlements/resolver";
export { CODE_TABLES, registerCountryPack, countryPack, rateFeed, setRateFeed } from "./localization/country-pack";
export type { ExchangeRatesPack, OfficialRate } from "./localization/country-pack";
export { DEFAULT_PHONE_CC, validateEmail, validatePhone } from "./validation";
export type { PartyTaxProfile, TaxLineInput, TaxedDocument, TaxedLine, TaxesPack } from "./localization/country-pack";
export type { CurrencyLegendInput, DianChecklist, DianChecklistItem, DocumentNumberRefusal, DrawnDocumentNumber, EInvoiceCertificateMeta, EInvoiceDocumentInput, EInvoiceIssuer, EInvoiceNoteInput, EInvoicePack, EInvoicePartyInput, PackTx, ResolutionInfo } from "./localization/country-pack";
export type { CodeTable, CountryPack, DocumentType, PartyFiscalInput, PartyValidation, ProductFiscalInput, ProductValidation, TaxIdResult } from "./localization/country-pack";
export { kernelModule } from "./module/kernel-module";
export { ATTACHMENT_PROCESSES, attachmentAdd, attachmentList, attachmentRemove, attachmentReorder, MAX_ATTACHMENT_BYTES, missingAttachments, precheckAttachment, requiredTagsFor, requirementApplies } from "./attachments";
export type { ConditionFacts, RecordFacts, RequiredTag } from "./attachments";
export { AI_PROCESSES, imageSuggest, PHOTO_AI_TAG } from "./ai/image-suggest";
export { initialsOf, placeholderImage } from "./ai/placeholder";
export { CUSTOM_MISSING_PREFIX, stripInvisible, validateCustomFields, validateCustomValue } from "./custom-fields";
export type { CustomFieldCaller, CustomFieldDef, CustomFieldsResult, CustomFieldType, ExtraData } from "./custom-fields";
export { CUSTOM_FIELD_PROCESSES, customData, customFieldList, customFieldRemove, customFieldSet, extraFree, loadCustomFields, visibleExtra } from "./custom-fields/server";
export type { CustomData, CustomFieldRow, CustomFieldView } from "./custom-fields/server";
export { normalizeVerifyValue, registeredVerifiers, registerVerifier, unregisterVerifier, verify, verifierAdapter, VERIFY_PROCESSES, verifyRequest, verifyStatus } from "./verify";
export type { VerifierAdapter, VerifyContext, VerifyKind, VerifyOutcome, VerifyStatus } from "./verify";
export { callerProfile, MAX_USER_PREF_BYTES, readUserPrefs, USER_PREF_KEY, USER_PREF_PROCESSES, userPrefSet } from "./user-prefs";
export type { CallerProfile, StoredUserPref } from "./user-prefs";
export { runnableProcesses } from "./process/permissions";
export { buildQuery, GridState, operatorsFor, QueryError, labelText, refLabelKey } from "./query";
export type { BuildQueryOptions, BuiltQuery, FilterOp, GridStateInput, QueryErrorCode } from "./query";
export { gridAccess, gridPageAccess, gridQueryInTx, runGridQuery, visibleIn } from "./query/run";
export { DATA_PROCESSES, DATA_QUERY_MAX_ROWS, dataQuery } from "./query/data-query.process";
export type { FieldMode, GridAccess, GridExtraField, GridQueryOptions, GridResult, GroupRow, PartyScope } from "./query/run";
export { addRefLabels } from "./query/ref-labels";
export { SAVED_VIEW_PROCESS_IDS, SAVED_VIEW_PROCESSES, SavedViewState } from "./saved-views";
export type { SavedView } from "./saved-views";
export { IMPORT_PROCESSES, importList, importPreview, importRun, importTemplate } from "./import/processes";
export type { ImportItem } from "./import/processes";
export { importEntity } from "./import/entity";
export { importColumns, importTarget } from "./import/columns";
export type { ImportColumn, ImportColumnType } from "./import/columns";
export { exportsStore, fileStore, setExportsStore, setFileStore } from "./files/store";
export { installedEInvoiceTransport, secretStore, setEInvoiceTransport, setSecretStore } from "./einvoice/seams";
export { DOC_TEMPLATE_FEATURE, DOC_TEMPLATE_PROCESSES, docTemplatePrint, docTemplateSave, docTemplateSetDefault, renderPrint } from "./templates/processes";
export type { PrintedDocument, PrintInput } from "./templates/processes";
export { Block, BLOCK_KINDS, DOC_TEMPLATE_ENTITY, docTemplateEntity, TEMPLATE_SCOPES, TemplateBlocks } from "./templates/schema";
export type { BlockKind, Template, TemplateScope } from "./templates/schema";
export { defaultTemplate, printableFields, printLabels } from "./templates/defaults";
export type { DefaultPresentation } from "./templates/defaults";
export { listVariables, resolveVariables, SYSTEM_VARIABLES, variableNames } from "./templates/variables";
export type { PrintCompany, PrintContext } from "./templates/variables";
export { consultProcessesOf, entitlementKeyOf, gridDenial, gridEntity, requireGridAccess } from "./query/access";
export type { GridDenial } from "./query/access";
export { EXPORT_PROCESSES, exportJobEntity, exportRows, moneyText, planExport, rateText } from "./exports";
export { defineReport, reportDenial, reportOf, ReportState, runReport, runReportFile } from "./reports";
export type { ReportColumn, ReportDef, ReportDenial, ReportFile, ReportFileAction, ReportResult } from "./reports";
export {
  buildHelpIndex,
  chunkGuide,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  embedQuery,
  FakeEmbedder,
  GatewayEmbedder,
  guideProblems,
  HELP_EMBED_TIMEOUT_MS,
  HELP_PROCESSES,
  helpEmbedder,
  helpSearch,
  installedHelpEmbedder,
  knownRoutes,
  loadGuides,
  processChunks,
  processHref,
  searchHelp,
  searchHelpByEmbedding,
  setHelpEmbedder,
} from "./help";
export type { EmbedOptions, Embedder, HelpIndexSummary, HelpResult } from "./help";
export { costUsd, DEFAULT_PRICE, MODEL_PRICES, priceOf, providerOfModel, recordLlmUsage } from "./ai/usage";
export type { EmbeddingUsage, LlmTask, LlmUsageRow, ModelPrice } from "./ai/usage";
export { ADMIN_FEATURE, ADMIN_PROCESSES, NESTED_FAILURE_PROCESSES, NESTED_FAILURES_FEATURE, NESTED_RUN_PROCESSES, authAdmin, matrixProcess, matrixProcesses, moduleStates, neededBy, parkedNotEntitled, readAiUsage, readPermissionMatrix, setAuthAdmin, syncRegistry } from "./admin";
export type { AiUsage, MatrixProcess, ModuleState, ParkedEvents, PermissionMatrix } from "./admin";
export { ADMIN_NAVIGATION } from "./admin/navigation";

export { aiTokensKpi, catalogItemSchema, catalogKey, chartSchema, dailyPoints, dailySeries, HOME_FEATURE, HOME_HIDDEN_PREF, HOME_PROCESSES, homeKpis, homeRecent, KERNEL_CHART_PROVIDERS, KERNEL_KPI_PROVIDERS, kpiGridHref, kpiSchema, recommendationDecide, recommendationList, SERIES_DAYS, suggestedAction,
  composeMessage, makeRecommendations, openRecommendations, paramValues, reasonKeyOf, recommendationCloseInput, recommendationParam, recommendationRaiseInput, RECOMMENDATION_PARAMS_MAX } from "./home";
export type { CatalogItem, RecommendationClose, RecommendationOut, RecommendationParam, RecommendationRaise, RecommendationsApi, SuggestedAction } from "./home";
export { BORRADOR_STATUS, documentLinkTrail, LINK_KIND, LINK_PROCESSES, linkEnd, LINKS_FROM_MAX, linksSyncInput, linksVoidInput, makeLinks, trailInput, trailNode, trailResult } from "./links";
export type { LinkEnd, LinksApi, LinksSync, LinksVoid, TrailInput, TrailNode, TrailResult } from "./links";

export type { AccountingPack, AccountLevel, AccountSeed, ExogenaCompany, ExogenaFormat, ExogenaRow, JournalKind, LineCode, StatementSection } from "./localization/country-pack";
export { ACCOUNT_ROLES, asPostingEngine, composeEntry, dismissParkedEvents, emitAndPostStrict, inlinePostingProcesses, lineDimensions, postingConsumer, POSTING_CONSUMER, interpolate, PathError, resolvePath, ruleApplies, RuleLine, RuleTemplate } from "./posting";
export type { InlinePosting } from "./posting";
export type { AccountRole, ComposeResult, ComposedEntry, ComposedLine, DefaultPostingRule, EventRef, PostingFailure, PostingFailureCode, PostingMode, PostingProvider, PostingRule, ResolvedAccount } from "./posting";
export { allowedActions, canEditData, isUsable, nextStatus } from "./typed";
export type { LifecycleAction, LifecycleFlags, RecordStatus } from "./typed";
export { assertReferencesUsable, GENERIC_VERBS, genericProcess, genericProcesses, isTypedEntity, runLifecycle, snapshotPayload, statusChangedEvent, typedHooksOf, writeSnapshot, causingUser, emitStatusChanged } from "./typed";
export type { GenericVerb, LifecycleInput, LifecycleResult, SnapshotPayload, StatusChangedPayload, TypedChange, TypedHooks, TypedRecord } from "./typed";
export { mailer, MAX_RECIPIENTS, NOTIFY_FEATURE, setMailer } from "./typed";
