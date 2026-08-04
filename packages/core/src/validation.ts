import type { ErrorObject } from "ajv";
import { parse as parseLanguageTag } from "bcp-47";

import type {
  Collection,
  CollectionSearchRequest,
  FilterDefinition,
  Offering,
  OfferingPage,
  OfferingSearchRequest,
  PageEnvelope,
  ProblemDetails,
  ResourceIdentity,
  ServiceDocument,
  SortDefinition
} from "./models.js";
import { ajv } from "./schema-registry.js";

function isLanguageTag(value: string): boolean {
  const parsed = parseLanguageTag(value, { normalize: false });
  const populated =
    parsed.language !== null ||
    parsed.irregular !== null ||
    parsed.regular !== null ||
    parsed.privateuse.length > 0;
  const variants = parsed.variants.map((variant) => variant.toLowerCase());
  const extensions = parsed.extensions.map(({ singleton }) => singleton.toLowerCase());
  return (
    populated &&
    new Set(variants).size === variants.length &&
    new Set(extensions).size === extensions.length
  );
}

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
  params: Readonly<Record<string, unknown>>;
}

export type SafeParseResult<Value> =
  { success: true; data: Value } | { success: false; issues: ValidationIssue[] };

export class OdpValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly documentType: string;

  constructor(documentType: string, issues: ValidationIssue[]) {
    super(`Invalid ODP ${documentType}`);
    this.name = "OdpValidationError";
    this.documentType = documentType;
    this.issues = issues;
  }
}

function issuesFrom(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "Validation failed",
    params: error.params
  }));
}

function serviceDocumentIssues(value: ServiceDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, keyword: string, message: string): void => {
    issues.push({ path, keyword, message, params: {} });
  };

  if ("id" in value) add("/id", "prohibited", "must not appear in a Service Document");
  if ("web_url" in value) add("/web_url", "prohibited", "must not appear in a Service Document");
  if (!isLanguageTag(value.language)) add("/language", "language-tag", "must be a language tag");

  const folded = value.localizations.map((language) => language.toLowerCase());
  if (value.localizations.some((language) => !isLanguageTag(language))) {
    add("/localizations", "language-tag", "must contain only language tags");
  }
  if (new Set(folded).size !== folded.length) {
    add("/localizations", "unique-language-tag", "must be unique without regard to case");
  }
  if (!folded.includes(value.language.toLowerCase())) {
    add("/localizations", "contains-default-language", "must contain the default language");
  }

  const keywordCodePoints = value.keywords?.reduce(
    (total, keyword) => total + Array.from(keyword).length,
    0
  );
  if (keywordCodePoints !== undefined && keywordCodePoints > 1024) {
    add("/keywords", "max-code-points", "must contain no more than 1024 code points in total");
  }
  if (
    value.search_capabilities !== undefined &&
    !value.operations.some(({ name }) => name === "search-offerings")
  ) {
    add("/search_capabilities", "operation-support", "requires the search-offerings operation");
  }
  return issues;
}

function localizedRepresentationIssues(value: {
  language?: string;
  localizations?: string[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const folded = value.localizations?.map((language) => language.toLowerCase());
  if (value.language !== undefined && !isLanguageTag(value.language)) {
    issues.push({
      path: "/language",
      keyword: "language-tag",
      message: "must be a language tag",
      params: {}
    });
  }
  if (value.localizations?.some((language) => !isLanguageTag(language)) === true) {
    issues.push({
      path: "/localizations",
      keyword: "language-tag",
      message: "must contain only language tags",
      params: {}
    });
  }
  if (folded !== undefined && new Set(folded).size !== folded.length) {
    issues.push({
      path: "/localizations",
      keyword: "unique-language-tag",
      message: "must be unique without regard to case",
      params: {}
    });
  }
  if (
    value.language !== undefined &&
    folded !== undefined &&
    !folded.includes(value.language.toLowerCase())
  ) {
    issues.push({
      path: "/localizations",
      keyword: "contains-language",
      message: "must contain the representation language",
      params: {}
    });
  }
  return issues;
}

function filterDefinitionIssues(value: FilterDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const comparisonOperators = new Set(["gt", "gte", "lt", "lte"]);
  if (
    (value.type === "string" || value.type === "boolean") &&
    value.operators.some((operator) => comparisonOperators.has(operator))
  ) {
    issues.push({
      path: "/operators",
      keyword: "operator-type",
      message: "contains an operator incompatible with the Filter type",
      params: {}
    });
  }
  if (value.type === "boolean" && value.unit !== undefined) {
    issues.push({
      path: "/unit",
      keyword: "unit-type",
      message: "must not appear on a boolean Filter",
      params: {}
    });
  }
  return issues;
}

function validator<Value>(
  schemaId: string,
  documentType: string,
  refine?: (value: Value) => ValidationIssue[]
) {
  const validate = ajv.getSchema<Value>(schemaId);
  if (validate === undefined) {
    throw new Error(`Missing bundled ODP schema: ${schemaId}`);
  }

  const safeParse = (value: unknown): SafeParseResult<Value> => {
    if (validate(value)) {
      const data = value as Value;
      const issues = refine?.(data) ?? [];
      if (issues.length === 0) return { success: true, data };
      return { success: false, issues };
    }
    return { success: false, issues: issuesFrom(validate.errors) };
  };

  const parse = (value: unknown): Value => {
    const result = safeParse(value);
    if (result.success) return result.data;
    throw new OdpValidationError(documentType, result.issues);
  };

  return { parse, safeParse };
}

const serviceDocument = validator<ServiceDocument>(
  "https://offeringprotocol.org/schemas/service-document.schema.json",
  "Service Document",
  serviceDocumentIssues
);
const collection = validator<Collection>(
  "https://offeringprotocol.org/schemas/collection.schema.json",
  "Collection",
  localizedRepresentationIssues
);
const offering = validator<Offering>(
  "https://offeringprotocol.org/schemas/offering.schema.json",
  "Offering",
  localizedRepresentationIssues
);
const problemDetails = validator<ProblemDetails>(
  "https://offeringprotocol.org/schemas/problem-details.schema.json",
  "Problem Details"
);
const resourceIdentity = validator<ResourceIdentity>(
  "https://offeringprotocol.org/schemas/resource-identity.schema.json",
  "resource identity"
);
const page = validator<PageEnvelope>(
  "https://offeringprotocol.org/schemas/page-envelope.schema.json",
  "page envelope"
);
const collectionSearchRequest = validator<CollectionSearchRequest>(
  "https://offeringprotocol.org/schemas/collection-search-request.schema.json",
  "Collection search request"
);
const offeringSearchRequest = validator<OfferingSearchRequest>(
  "https://offeringprotocol.org/schemas/offering-search-request.schema.json",
  "Offering search request"
);
const offeringSearchResponse = validator<OfferingPage>(
  "https://offeringprotocol.org/schemas/offering-search-response.schema.json",
  "Offering search response"
);
const filterDefinition = validator<FilterDefinition>(
  "https://offeringprotocol.org/schemas/filter-definition.schema.json",
  "Filter Definition",
  filterDefinitionIssues
);
const sortDefinition = validator<SortDefinition>(
  "https://offeringprotocol.org/schemas/sort-definition.schema.json",
  "Sort Definition"
);
const filterDefinitionPage = validator<PageEnvelope<FilterDefinition>>(
  "https://offeringprotocol.org/schemas/filter-definition-page.schema.json",
  "Filter Definition page"
);
const sortDefinitionPage = validator<PageEnvelope<SortDefinition>>(
  "https://offeringprotocol.org/schemas/sort-definition-page.schema.json",
  "Sort Definition page"
);

export const parseServiceDocument = serviceDocument.parse;
export const safeParseServiceDocument = serviceDocument.safeParse;
export const parseCollection = collection.parse;
export const safeParseCollection = collection.safeParse;
export const parseOffering = offering.parse;
export const safeParseOffering = offering.safeParse;
export const parseProblemDetails = problemDetails.parse;
export const safeParseProblemDetails = problemDetails.safeParse;
export const parseResourceIdentity = resourceIdentity.parse;
export const safeParseResourceIdentity = resourceIdentity.safeParse;
export const parsePage = page.parse;
export const safeParsePage = page.safeParse;
export const parseCollectionSearchRequest = collectionSearchRequest.parse;
export const safeParseCollectionSearchRequest = collectionSearchRequest.safeParse;
export const parseOfferingSearchRequest = offeringSearchRequest.parse;
export const safeParseOfferingSearchRequest = offeringSearchRequest.safeParse;
export const parseOfferingSearchResponse = offeringSearchResponse.parse;
export const safeParseOfferingSearchResponse = offeringSearchResponse.safeParse;
export const parseFilterDefinition = filterDefinition.parse;
export const safeParseFilterDefinition = filterDefinition.safeParse;
export const parseSortDefinition = sortDefinition.parse;
export const safeParseSortDefinition = sortDefinition.safeParse;
export const parseFilterDefinitionPage = filterDefinitionPage.parse;
export const safeParseFilterDefinitionPage = filterDefinitionPage.safeParse;
export const parseSortDefinitionPage = sortDefinitionPage.parse;
export const safeParseSortDefinitionPage = sortDefinitionPage.safeParse;

export function parseProblemResponse(value: unknown, httpStatus: number): ProblemDetails {
  const problem = parseProblemDetails(value);
  if (problem.status !== httpStatus) {
    throw new OdpValidationError("Problem Details", [
      {
        path: "/status",
        keyword: "http-status",
        message: "must match the HTTP response status",
        params: { httpStatus }
      }
    ]);
  }
  return problem;
}
