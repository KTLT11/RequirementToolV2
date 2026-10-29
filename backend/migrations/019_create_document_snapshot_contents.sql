-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 019
-- Creates document_snapshot_contents — the storage location for a
-- DocumentSnapshot's frozen structured content (Phase 6 P3, per the
-- approved "P3 Plan Revised" section 2/6).
--
-- GAP CONFIRMED (not inferred): document_snapshots' 10 real columns
-- (read via pg_attribute before writing migration 018) are
-- snapshot_id, document_id, manifest_id, snapshot_version,
-- storage_object_path (text), content_sha256 (char(64)),
-- content_mime_type (varchar), rendered_at, rendered_by, render_status
-- — none of them JSONB, and no other table among the 7 Document/
-- Confirmation/Handoff group tables carries a JSONB content column
-- either. There is therefore no existing place to persist the actual
-- structured Document Model payload a snapshot freezes - only a
-- logical path string and a hash of content stored elsewhere. This is
-- exactly the gap the approved P3 Plan Revised anticipated and
-- conditionally authorized a new table for (section 2: "chỉ tạo
-- document_snapshot_contents nếu kiểm tra DDL đầy đủ xác nhận không
-- có nơi lưu JSON tương đương").
--
-- This is the ONLY new table this migration creates - no other table/
-- column/enum is added, per the explicit instruction not to extend
-- beyond the approved P3 scope. storage_object_path on
-- document_snapshots keeps its existing role (a logical/future
-- artifact reference, e.g. for an eventual rendered HTML/DOCX/PDF
-- file) and is NOT used to store or compete with this JSONB content -
-- the two are deliberately separate per the Plan's section 6
-- instruction.
--
-- Design: 1:1 with document_snapshots via snapshot_id as BOTH primary
-- key and foreign key (not a separate surrogate id) - this table can
-- never exist without, or diverge in identity from, its owning
-- snapshot row. content is NOT NULL (a snapshot is never created
-- without its content - see src/modules/documents/service.ts's
-- createSnapshotService, which writes both rows in one transaction).
-- No UPDATE or DELETE grant is given, AND a trigger enforces the same
-- immutability at the database level that rt_protect_document_snapshot
-- already enforces on the parent row - matching the instruction that
-- "dữ liệu JSONB phải bất biến sau khi snapshot hoàn tất, có kiểm
-- soát UPDATE và DELETE" (not relying solely on withholding the grant,
-- the same defense-in-depth posture used everywhere else in this
-- schema for immutable records).
--
-- Apply manually on Machine A, AFTER 001-018.
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.document_snapshot_contents (
    snapshot_id uuid PRIMARY KEY REFERENCES public.document_snapshots(snapshot_id),
    content jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.rt_protect_document_snapshot_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    RAISE EXCEPTION
        'Document snapshot content is immutable - cannot be updated or deleted';
END;
$function$;

DROP TRIGGER IF EXISTS rt_document_snapshot_content_immutable ON public.document_snapshot_contents;
CREATE TRIGGER rt_document_snapshot_content_immutable
    BEFORE UPDATE OR DELETE ON public.document_snapshot_contents
    FOR EACH ROW EXECUTE FUNCTION public.rt_protect_document_snapshot_content();

ALTER TABLE public.document_snapshot_contents ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------
-- Grants — SELECT, INSERT only (no UPDATE/DELETE grant at all, on
-- top of the trigger above rejecting both outright - the same
-- belt-and-suspenders pattern used for every other immutable record
-- in this schema, e.g. entity_revisions, baseline_manifests once
-- FROZEN).
-- ---------------------------------------------------------

GRANT SELECT, INSERT ON public.document_snapshot_contents TO app_backend;

DROP POLICY IF EXISTS rt_app_backend_select ON public.document_snapshot_contents;
CREATE POLICY rt_app_backend_select ON public.document_snapshot_contents
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.document_snapshot_contents;
CREATE POLICY rt_app_backend_insert ON public.document_snapshot_contents
    FOR INSERT TO app_backend WITH CHECK (true);

COMMIT;

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend' AND table_name = 'document_snapshot_contents'
--   ORDER BY privilege_type;
--   -- Expect: INSERT, SELECT only. No UPDATE/DELETE.
--
--   -- Negative test (should raise an exception, run as app_backend):
--   --   UPDATE document_snapshot_contents SET content = '{}'::jsonb
--   --   WHERE snapshot_id = '<any existing id>';
--   -- Expect: ERROR - Document snapshot content is immutable...
-- ---------------------------------------------------------
