// Stakeholder — a reusable profile, not scoped to any one Case
// (per the Data Dictionary's own framing: "Shared identity"). A
// Stakeholder is linked to a Case separately via CaseStakeholder
// (see src/modules/case-stakeholders).
//
// No EntityIdentity/EntityRevision - stakeholders has no FK to
// entity_identities in the applied (repaired) schema.

import { HttpError } from "../../http/errors.js";
import * as repo from "./repository.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listStakeholdersService() {
  const rows = await repo.findAllStakeholders();
  return { data: rows };
}

export async function getStakeholderService(stakeholderId: string) {
  if (!isUuid(stakeholderId)) {
    throw new HttpError("VALIDATION_ERROR", "stakeholder_id must be a valid UUID");
  }
  const row = await repo.findStakeholderById(stakeholderId);
  if (!row) {
    throw new HttpError("NOT_FOUND", `Stakeholder ${stakeholderId} was not found`);
  }
  return { data: row };
}

export interface CreateStakeholderInput {
  display_name?: unknown;
  external_reference?: unknown;
  organization?: unknown;
  contact_email?: unknown;
  contact_channel?: unknown;
}

export async function createStakeholderService(body: CreateStakeholderInput) {
  if (!isNonEmptyString(body.display_name)) {
    throw new HttpError("VALIDATION_ERROR", "display_name is required");
  }
  const externalReference =
    typeof body.external_reference === "string" ? body.external_reference : null;
  const organization = typeof body.organization === "string" ? body.organization : null;
  const contactEmail = typeof body.contact_email === "string" ? body.contact_email : null;
  const contactChannel = typeof body.contact_channel === "string" ? body.contact_channel : null;

  const result = await repo.insertStakeholder({
    externalReference,
    displayName: body.display_name as string,
    organization,
    contactEmail,
    contactChannel,
  });

  return { data: result };
}
