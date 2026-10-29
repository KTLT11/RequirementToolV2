import { getPool } from "../../db/pool.js";

export interface StakeholderRow {
  stakeholder_id: string;
  external_reference: string | null;
  display_name: string;
  organization: string | null;
  contact_email: string | null;
  contact_channel: string | null;
  identity_status: string;
  created_at: string;
  updated_at: string;
}

export async function findAllStakeholders(): Promise<StakeholderRow[]> {
  const { rows } = await getPool().query<StakeholderRow>(
    `SELECT stakeholder_id, external_reference, display_name, organization,
            contact_email, contact_channel, identity_status, created_at, updated_at
     FROM stakeholders
     ORDER BY display_name ASC`,
  );
  return rows;
}

export async function findStakeholderById(stakeholderId: string): Promise<StakeholderRow | null> {
  const { rows } = await getPool().query<StakeholderRow>(
    `SELECT stakeholder_id, external_reference, display_name, organization,
            contact_email, contact_channel, identity_status, created_at, updated_at
     FROM stakeholders
     WHERE stakeholder_id = $1`,
    [stakeholderId],
  );
  return rows[0] ?? null;
}

export async function insertStakeholder(params: {
  externalReference: string | null;
  displayName: string;
  organization: string | null;
  contactEmail: string | null;
  contactChannel: string | null;
}): Promise<StakeholderRow> {
  const { rows } = await getPool().query<StakeholderRow>(
    `INSERT INTO stakeholders
       (external_reference, display_name, organization, contact_email, contact_channel)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING stakeholder_id, external_reference, display_name, organization,
               contact_email, contact_channel, identity_status, created_at, updated_at`,
    [params.externalReference, params.displayName, params.organization, params.contactEmail, params.contactChannel],
  );
  return rows[0]!;
}
