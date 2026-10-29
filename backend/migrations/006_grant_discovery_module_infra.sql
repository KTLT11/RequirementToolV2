-- =========================================================
-- REQUIREMENT TOOL V2 — Node.js Backend Migration 006
-- Grants for: Discovery & Guidance (P3-FR-006/008/009/010)
--
-- Tables already exist (applied earlier on the Migration branch):
--   module_applications, discovery_answers, information_gaps
--     (migration 20261022071332_create_discovery_schema.sql)
--   definition_versions
--     (migration 20261022072441_create_integrity_validation_schema.sql,
--      read-only here — Rule Registry, no admin API per FR-023 AC-04)
--
-- SCHEMA NOTE (corrected after a live integration-test failure):
-- the table-creation migration alone
-- (20261022071332_create_discovery_schema.sql) defines
-- module_applications.*_id, discovery_answers.answer_id, and
-- information_gaps.gap_id as plain
-- `uuid PRIMARY KEY DEFAULT gen_random_uuid()` with no FK to
-- entity_identities. A LATER repair migration
-- (20261022074857_repair_entity_identity_foreign_keys.sql) adds that
-- FK to 13 tables — INCLUDING discovery_answers.answer_id and
-- information_gaps.gap_id, but NOT module_applications. This was
-- missed on first reading (only the table-creation migration was
-- checked, not the full migration history) and surfaced as a live
-- 23503 foreign-key violation during integration testing. Corrected
-- conclusion: Context/Scope (migration 005), Discovery Answer, and
-- Information Gap all use the EntityIdentity/EntityRevision pattern
-- (registerEntity + createRevision on every create/update) because
-- their tables genuinely carry that FK. Module Application does NOT
-- carry it (confirmed absent from the repair migration's 13-table
-- list) and its own code correctly does not call
-- registerEntity()/createRevision(). definition_versions also carries
-- a real, original FK to entity_identities and uses the same pattern
-- for its own seed rows (section 3 below).
--
-- Apply manually on Machine A, AFTER 001-005. Written to be safely
-- re-runnable: every GRANT/POLICY/INSERT below is guarded so running
-- this file twice does not error and does not duplicate rows.
-- =========================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Grants — verified against the planned repository code:
--
--   module_applications   SELECT, INSERT, UPDATE — list/apply modules
--                          to a Case, and mark application_status
--                          ACTIVE/COMPLETED/REMOVED. No DELETE —
--                          removing a module is a status change
--                          (REMOVED), not a row deletion, matching the
--                          CHECK constraint's own vocabulary.
--
--   discovery_answers      SELECT, INSERT, UPDATE — record/update
--                           answers; UPDATE bumps current_revision_no
--                           in the row itself (no separate revision
--                           table exists for this table in the applied
--                           schema, per the note above). No DELETE —
--                           an answer is revised, not removed.
--
--   information_gaps       SELECT, INSERT, UPDATE — create gaps and
--                           transition gap_status
--                           (OPEN -> CLARIFYING -> RESOLVED). No
--                           DELETE — a gap is resolved, not removed,
--                           matching resolved_at being a nullable
--                           timestamp rather than row deletion.
--
--   definition_versions    SELECT only — Rule Registry is read-only
--                           for the Node.js backend per FR-023 AC-04
--                           / FR-023B AC-04 ("no admin UI required in
--                           MVP"). Seed data is inserted directly via
--                           this same migration file (section 3
--                           below) as `postgres`/the migration-running
--                           role, not through app_backend — app_backend
--                           never needs INSERT here because it never
--                           creates new rule/module/question
--                           definitions, only reads existing ones to
--                           validate module_definition_version_id /
--                           question_definition_version_id references.
-- ---------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.module_applications TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.discovery_answers TO app_backend;
GRANT SELECT, INSERT, UPDATE ON public.information_gaps TO app_backend;
GRANT SELECT ON public.definition_versions TO app_backend;

-- ---------------------------------------------------------
-- 2. RLS — these 4 tables already have RLS ENABLED and the existing
-- `rt_ba_read` policy from migration 13 (left untouched). Adding the
-- same per-operation app_backend-scoped pattern as migrations 003-005.
-- Guarded with a DROP POLICY IF EXISTS first so re-running this file
-- does not fail with "policy already exists".
-- ---------------------------------------------------------

DROP POLICY IF EXISTS rt_app_backend_select ON public.module_applications;
CREATE POLICY rt_app_backend_select ON public.module_applications
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.module_applications;
CREATE POLICY rt_app_backend_insert ON public.module_applications
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.module_applications;
CREATE POLICY rt_app_backend_update ON public.module_applications
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.discovery_answers;
CREATE POLICY rt_app_backend_select ON public.discovery_answers
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.discovery_answers;
CREATE POLICY rt_app_backend_insert ON public.discovery_answers
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.discovery_answers;
CREATE POLICY rt_app_backend_update ON public.discovery_answers
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.information_gaps;
CREATE POLICY rt_app_backend_select ON public.information_gaps
    FOR SELECT TO app_backend USING (true);
DROP POLICY IF EXISTS rt_app_backend_insert ON public.information_gaps;
CREATE POLICY rt_app_backend_insert ON public.information_gaps
    FOR INSERT TO app_backend WITH CHECK (true);
DROP POLICY IF EXISTS rt_app_backend_update ON public.information_gaps;
CREATE POLICY rt_app_backend_update ON public.information_gaps
    FOR UPDATE TO app_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS rt_app_backend_select ON public.definition_versions;
CREATE POLICY rt_app_backend_select ON public.definition_versions
    FOR SELECT TO app_backend USING (true);

-- ---------------------------------------------------------
-- 3. Rule Registry seed data.
--
-- 3a. One DefinitionVersion row per Discovery Module
-- (definition_type = 'MODULE'), sourced directly from
-- Requirement_Framework.md section 2.6.1 ("Danh mục module") and each
-- module's own section (2.6.3 Process through 2.4.9 NFR). No rule
-- content is invented here beyond what that document already
-- specifies: module id, applicable condition (free-text "Điều kiện
-- áp dụng" from section B of each module), and a short description.
--
-- 3b. One DefinitionVersion row per Discovery question
-- (definition_type = 'QUESTION'), one per question actually listed
-- in each module's "C. Ordered Elicitation Guide" table in the same
-- source document — all 101 of them (PROC=19, INT=16, RULE=14,
-- DATA=17, PERM=14, EXC=12, NFR=9, counted directly from the document
-- and cross-checked twice, not assumed). question_id, question text
-- ("Câu hỏi khai thác"), and Required Information are copied verbatim
-- — no paraphrasing, no invented questions. Each question's owning
-- module is recorded in its `applicability` jsonb
-- (`{"module_code": "PROC"}`) since there is no FK column to link
-- them — this is a link for lookup/display purposes only, not a rule
-- engine: no check logic is evaluated against this data anywhere in
-- this slice.
--
-- This is NOT a general rule engine or Rule Definition — only Module
-- and Question identities are registered, so
-- module_applications.module_definition_version_id and
-- discovery_answers.question_definition_version_id have something
-- real to reference. A Question is never converted into or treated
-- as a Rule (definition_type stays 'QUESTION', distinct from
-- 'CHECK_RULE', which is not seeded anywhere in this migration).
-- Evaluating any check logic against these definitions remains out of
-- scope (FR-024 internal regression tooling is also out of scope).
--
-- Idempotent: definition_code is the natural key here (PROC, INT,
-- ..., and PROC-Q-01, INT-Q-01, ... for questions) — each INSERT is
-- guarded by a NOT EXISTS check against definition_code, so
-- re-running this file is a no-op for rows already seeded rather than
-- a duplicate or an error.
-- ---------------------------------------------------------

DO $$
DECLARE
    v_definition_id uuid;
    v_module record;
    v_question record;
BEGIN
    -- 3a. Modules
    FOR v_module IN
        SELECT * FROM (VALUES
            ('PROC', 'Process Discovery Module',
             'Yêu cầu liên quan đến quy trình hoặc luồng xử lý: tạo mới/thay đổi quy trình, tự động hóa bước xử lý, thay đổi trình tự/trách nhiệm/điều kiện chuyển bước.'),
            ('INT', 'Integration Discovery Module',
             'Có tương tác hoặc trao đổi dữ liệu giữa các hệ thống: process step gửi/nhận dữ liệu, phụ thuộc API/service/external system.'),
            ('RULE', 'Business Rule Discovery Module',
             'Behavior thay đổi theo điều kiện nghiệp vụ: decision point cần làm rõ logic, kết quả phụ thuộc threshold/status/category/role/dữ liệu.'),
            ('DATA', 'Data / Entity Discovery Module',
             'Requirement tạo/đọc/cập nhật/sử dụng dữ liệu: behavior phụ thuộc attribute/value/state của entity, có relationship giữa nhiều entity.'),
            ('PERM', 'Permission Discovery Module',
             'Behavior khác nhau theo actor/role: thao tác chỉ được phép với một số người dùng, quyền xem/tạo/sửa/xóa/phê duyệt dữ liệu bị giới hạn.'),
            ('EXC', 'Exception Discovery Module',
             'Process có failure/alternative case cần xử lý riêng: integration lỗi/timeout, dữ liệu thiếu/sai, business rule có exception/override.'),
            ('NFR', 'Non-Functional Requirement Discovery Module',
             'Yêu cầu có constraint hoặc quality attribute: performance, security, availability, auditability, compliance, capacity, usability.')
        ) AS t(module_code, module_name, applicability_text)
    LOOP
        IF EXISTS (
            SELECT 1 FROM public.definition_versions
            WHERE definition_type = 'MODULE' AND definition_code = v_module.module_code
        ) THEN
            CONTINUE;
        END IF;

        INSERT INTO public.entity_identities (entity_id, entity_type)
        VALUES (gen_random_uuid(), 'DEFINITION')
        RETURNING entity_id INTO v_definition_id;

        INSERT INTO public.definition_versions (
            definition_id, definition_type, definition_code, version_no,
            applicability, definition_body, content_sha256, status, published_at
        ) VALUES (
            v_definition_id,
            'MODULE',
            v_module.module_code,
            1,
            jsonb_build_object('description', v_module.applicability_text),
            jsonb_build_object(
                'module_name', v_module.module_name,
                'source', 'Requirement_Framework.md section 2.6 (Discovery Modules)'
            ),
            encode(sha256(
                (v_module.module_code || v_module.module_name || v_module.applicability_text)::bytea
            ), 'hex'),
            'ACTIVE',
            now()
        );
    END LOOP;

    -- 3b. Questions — 101 rows, one per question in each module's
    -- Ordered Elicitation Guide. module_code here is purely for the
    -- `applicability` jsonb link described above, not a storage
    -- grouping key.
    FOR v_question IN
        SELECT * FROM (VALUES
            ('PROC', 'PROC-Q-01', 'Quy trình cần tìm hiểu bắt đầu từ sự kiện nào và kết thúc khi nào?', 'Process boundary, start/end trigger.'),
            ('PROC', 'PROC-Q-02', 'Đầu vào và kết quả đầu ra của quy trình là gì?', 'Process input/output.'),
            ('PROC', 'PROC-Q-03', 'Những actor hoặc bộ phận nào tham gia vào quy trình?', 'Process actors.'),
            ('PROC', 'PROC-Q-04', 'Sau khi quy trình bắt đầu, các bước hiện tại diễn ra theo thứ tự nào?', 'Current process steps.'),
            ('PROC', 'PROC-Q-05', 'Ai thực hiện từng bước và sử dụng thông tin gì?', 'Step owner, input/output.'),
            ('PROC', 'PROC-Q-06', 'Điều kiện nào quyết định việc chuyển từ bước này sang bước tiếp theo?', 'Transition conditions.'),
            ('PROC', 'PROC-Q-07', 'Vấn đề đã xác định trong Core Discovery xuất hiện hoặc thể hiện tại bước nào của quy trình hiện tại?', 'Problem-to-process-step mapping.'),
            ('PROC', 'PROC-Q-08', 'Những bước nào cần giữ nguyên, bổ sung, thay đổi hoặc loại bỏ?', 'Process changes.'),
            ('PROC', 'PROC-Q-09', 'Quy trình mong muốn sẽ diễn ra theo thứ tự nào?', 'Target process flow.'),
            ('PROC', 'PROC-Q-10', 'Ai hoặc hệ thống nào chịu trách nhiệm thực hiện từng bước?', 'Target step owner.'),
            ('PROC', 'PROC-Q-11', 'Mỗi bước cần nhận thông tin gì và tạo ra kết quả gì?', 'Target step input/output.'),
            ('PROC', 'PROC-Q-12', 'Điều kiện nào xác định một bước đã hoàn thành và có thể chuyển tiếp?', 'Completion/transition conditions.'),
            ('PROC', 'PROC-Q-12A', 'Sau bước này, đối tượng nghiệp vụ có thay đổi trạng thái không? Nếu có, trạng thái mới là gì?', 'Business object state change.'),
            ('PROC', 'PROC-Q-13', 'Tại những bước nào quy trình có thể rẽ sang nhiều hướng xử lý?', 'Decision points.'),
            ('PROC', 'PROC-Q-14', 'Điều kiện nào dẫn đến từng nhánh và kết quả của mỗi nhánh là gì?', 'Branch conditions/outcomes.'),
            ('PROC', 'PROC-Q-15', 'Có tình huống nào khiến quy trình phải quay lại bước trước, tạm dừng hoặc kết thúc sớm không?', 'Alternative flows.'),
            ('PROC', 'PROC-Q-16', 'Bước nào phụ thuộc vào hệ thống, bộ phận hoặc quy trình khác?', 'Process dependencies.'),
            ('PROC', 'PROC-Q-17', 'Nếu một bước phụ thuộc chưa hoàn thành, quy trình cần xử lý như thế nào?', 'Dependency behavior.'),
            ('PROC', 'PROC-Q-18', 'Quy trình mong muốn đã bao phủ các bước và nhánh xử lý trong phạm vi chưa? Có nội dung nào cần xác nhận thêm không?', 'Process validation results.'),
            ('INT', 'INT-Q-01', 'Integration này phục vụ bước hoặc hành vi nghiệp vụ nào?', 'Integration purpose/context'),
            ('INT', 'INT-Q-02', 'Những hệ thống nào tham gia? Hệ thống nào gửi và hệ thống nào nhận?', 'Source / target system'),
            ('INT', 'INT-Q-03', 'Interaction bắt đầu và kết thúc ở đâu trong phạm vi requirement?', 'Integration boundary'),
            ('INT', 'INT-Q-04', 'Điều gì làm integration bắt đầu?', 'Integration trigger'),
            ('INT', 'INT-Q-05', 'Integration xảy ra ngay khi event xảy ra hay vào thời điểm khác?', 'Interaction timing'),
            ('INT', 'INT-Q-06', 'Có điều kiện nào quyết định integration có được thực hiện hay không?', 'Invocation condition'),
            ('INT', 'INT-Q-07', 'Hệ thống cần gửi hoặc nhận những thông tin gì?', 'Data exchanged'),
            ('INT', 'INT-Q-08', 'Dữ liệu được lấy từ đâu và kết quả được sử dụng ở đâu?', 'Data source / usage'),
            ('INT', 'INT-Q-09', 'Có validation hoặc mapping nào cần áp dụng cho dữ liệu không?', 'Data validation / mapping'),
            ('INT', 'INT-Q-10', 'Kết quả nào được xem là integration thành công?', 'Success outcome'),
            ('INT', 'INT-Q-11', 'Sau khi nhận kết quả, hệ thống hoặc process cần làm gì tiếp theo?', 'Result handling'),
            ('INT', 'INT-Q-12', 'Có response hoặc trạng thái nào cần được ghi nhận không?', 'Response / state'),
            ('INT', 'INT-Q-13', 'Nếu hệ thống không nhận được response hoặc integration thất bại thì cần xử lý thế nào?', 'Failure behavior'),
            ('INT', 'INT-Q-14', 'Có trường hợp cần retry, chờ xử lý hoặc chuyển sang luồng khác không?', 'Retry / alternative behavior'),
            ('INT', 'INT-Q-15', 'Integration phụ thuộc vào hệ thống, service hoặc team nào khác không?', 'Integration dependency'),
            ('INT', 'INT-Q-16', 'Có điểm nào chưa được xác nhận hoặc cần stakeholder khác quyết định không?', 'Open issues'),
            ('RULE', 'RULE-Q-01', 'Rule này áp dụng cho behavior hoặc tình huống nào?', 'Rule context'),
            ('RULE', 'RULE-Q-02', 'Rule áp dụng cho đối tượng, actor hoặc phạm vi nào?', 'Rule scope'),
            ('RULE', 'RULE-Q-03', 'Điều kiện nào khiến rule được áp dụng?', 'Applicability condition'),
            ('RULE', 'RULE-Q-04', 'Nếu điều kiện này xảy ra thì hệ thống cần xử lý thế nào?', 'Rule action / outcome'),
            ('RULE', 'RULE-Q-05', 'Rule dựa trên những dữ liệu hoặc giá trị nào?', 'Rule inputs'),
            ('RULE', 'RULE-Q-06', 'Có threshold, range, status hoặc category cụ thể nào không?', 'Rule criteria'),
            ('RULE', 'RULE-Q-07', 'Có rule nào khác cùng ảnh hưởng đến behavior này không?', 'Related rules'),
            ('RULE', 'RULE-Q-08', 'Nếu nhiều rule cùng áp dụng thì rule nào được ưu tiên hoặc xử lý trước?', 'Rule priority'),
            ('RULE', 'RULE-Q-09', 'Có trường hợp các rule cho kết quả khác nhau hoặc conflict không?', 'Rule conflict'),
            ('RULE', 'RULE-Q-10', 'Có trường hợp nào rule này không áp dụng dù điều kiện thông thường đã thỏa không?', 'Rule exception'),
            ('RULE', 'RULE-Q-11', 'Có actor hoặc trường hợp nào được phép override rule không?', 'Override condition'),
            ('RULE', 'RULE-Q-12', 'Nếu exception hoặc override xảy ra thì behavior mong đợi là gì?', 'Exception / override behavior'),
            ('RULE', 'RULE-Q-13', 'Làm thế nào để xác định rule đã được áp dụng đúng?', 'Validation condition'),
            ('RULE', 'RULE-Q-14', 'Có rule nào chưa được xác nhận hoặc cần stakeholder khác quyết định không?', 'Open rule issues'),
            ('DATA', 'DATA-Q-01', 'Requirement này liên quan đến những đối tượng nghiệp vụ nào?', 'Business entities'),
            ('DATA', 'DATA-Q-02', 'Mỗi entity được sử dụng trong behavior hoặc process nào?', 'Entity context'),
            ('DATA', 'DATA-Q-03', 'Entity nào là đối tượng chính và entity nào liên quan?', 'Primary / related entities'),
            ('DATA', 'DATA-Q-04', 'Với mỗi entity, những thông tin nào cần được sử dụng hoặc lưu lại?', 'Required attributes'),
            ('DATA', 'DATA-Q-05', 'Thuộc tính nào bắt buộc và thuộc tính nào có thể không có?', 'Mandatory / optional data'),
            ('DATA', 'DATA-Q-06', 'Có giá trị, format hoặc range nào cần giới hạn không?', 'Attribute constraints'),
            ('DATA', 'DATA-Q-07', 'Dữ liệu này được lấy từ đâu hoặc do ai cung cấp?', 'Data source'),
            ('DATA', 'DATA-Q-08', 'Hệ thống hoặc bộ phận nào chịu trách nhiệm về dữ liệu này?', 'Data ownership'),
            ('DATA', 'DATA-Q-09', 'Nếu cùng một dữ liệu xuất hiện ở nhiều nguồn thì nguồn nào được dùng làm căn cứ?', 'Source of truth'),
            ('DATA', 'DATA-Q-10', 'Các entity có quan hệ với nhau như thế nào?', 'Entity relationship'),
            ('DATA', 'DATA-Q-11', 'Có giới hạn về số lượng hoặc quan hệ giữa các entity không?', 'Relationship constraints'),
            ('DATA', 'DATA-Q-12', 'Entity có những trạng thái nào ảnh hưởng đến behavior hoặc process?', 'Entity state'),
            ('DATA', 'DATA-Q-13', 'Điều gì làm entity chuyển từ trạng thái này sang trạng thái khác?', 'State transition condition'),
            ('DATA', 'DATA-Q-14', 'Điều kiện nào xác định dữ liệu là hợp lệ?', 'Data validation'),
            ('DATA', 'DATA-Q-15', 'Nếu dữ liệu thiếu hoặc không hợp lệ thì behavior mong đợi là gì?', 'Invalid / missing data behavior'),
            ('DATA', 'DATA-Q-16', 'Có trường hợp duplicate hoặc conflicting data cần xử lý không?', 'Duplicate / conflict handling'),
            ('DATA', 'DATA-Q-17', 'Có nội dung dữ liệu nào chưa được xác nhận hoặc cần nguồn khác làm rõ không?', 'Open data issues'),
            ('PERM', 'PERM-Q-01', 'Những actor hoặc role nào liên quan đến behavior này?', 'Relevant roles'),
            ('PERM', 'PERM-Q-02', 'Mỗi role được phép thực hiện những thao tác nào?', 'Allowed actions'),
            ('PERM', 'PERM-Q-03', 'Có thao tác nào role không được phép thực hiện không?', 'Restricted actions'),
            ('PERM', 'PERM-Q-04', 'Quyền này áp dụng trên dữ liệu hoặc phạm vi nào?', 'Access scope'),
            ('PERM', 'PERM-Q-05', 'User được thao tác trên toàn bộ dữ liệu hay chỉ dữ liệu thuộc phạm vi của mình?', 'Data scope'),
            ('PERM', 'PERM-Q-06', 'Có giới hạn theo team, department, tenant, project hoặc phạm vi khác không?', 'Scope restriction'),
            ('PERM', 'PERM-Q-07', 'Quyền có thay đổi theo trạng thái hoặc điều kiện nào không?', 'Permission condition'),
            ('PERM', 'PERM-Q-08', 'Có trường hợp actor chỉ được thực hiện action khi thỏa điều kiện cụ thể không?', 'Conditional permission'),
            ('PERM', 'PERM-Q-09', 'Có rule nghiệp vụ nào quyết định quyền này không?', 'Permission rule'),
            ('PERM', 'PERM-Q-10', 'Một user có thể có nhiều role cùng lúc không?', 'Role relationship'),
            ('PERM', 'PERM-Q-11', 'Nếu nhiều role có quyền khác nhau thì quyền nào được áp dụng?', 'Permission conflict / priority'),
            ('PERM', 'PERM-Q-12', 'Có actor hoặc role nào được phép override quyền thông thường không?', 'Override permission'),
            ('PERM', 'PERM-Q-13', 'Nếu user không có quyền thì behavior mong đợi là gì?', 'Unauthorized behavior'),
            ('PERM', 'PERM-Q-14', 'Có trường hợp permission chưa được xác nhận hoặc cần stakeholder khác quyết định không?', 'Open permission issues'),
            ('EXC', 'EXC-Q-01', 'Tình huống bất thường hoặc failure nào có thể xảy ra?', 'Exception scenario'),
            ('EXC', 'EXC-Q-02', 'Exception xảy ra tại behavior hoặc bước nào?', 'Exception context'),
            ('EXC', 'EXC-Q-03', 'Điều kiện nào làm exception phát sinh?', 'Trigger / condition'),
            ('EXC', 'EXC-Q-04', 'Khi exception xảy ra, hệ thống cần xử lý thế nào?', 'Expected exception behavior'),
            ('EXC', 'EXC-Q-05', 'User hoặc hệ thống khác cần nhận được kết quả/thông báo gì?', 'Exception outcome'),
            ('EXC', 'EXC-Q-06', 'Có dữ liệu hoặc trạng thái nào cần được cập nhật không?', 'State / data impact'),
            ('EXC', 'EXC-Q-07', 'Sau khi xử lý exception, flow tiếp tục, quay lại, tạm dừng hay kết thúc?', 'Flow impact'),
            ('EXC', 'EXC-Q-08', 'Có thể retry hoặc thực hiện lại action không?', 'Retry / recovery behavior'),
            ('EXC', 'EXC-Q-09', 'Có cần action thủ công hoặc stakeholder khác xử lý tiếp không?', 'Manual follow-up'),
            ('EXC', 'EXC-Q-10', 'Exception này có cần phân biệt theo mức độ hoặc loại không?', 'Exception classification'),
            ('EXC', 'EXC-Q-11', 'Có trường hợp nào cần escalation hoặc chuyển cho actor khác không?', 'Escalation behavior'),
            ('EXC', 'EXC-Q-12', 'Có exception nào chưa có quyết định xử lý rõ ràng không?', 'Open exception issues'),
            ('NFR', 'NFR-Q-01', 'Non-functional concern nào ảnh hưởng đến requirement hoặc behavior này?', 'NFR category'),
            ('NFR', 'NFR-Q-02', 'Concern này áp dụng cho behavior, user, system hoặc condition nào?', 'Applicability context'),
            ('NFR', 'NFR-Q-03', 'Concern này xuất phát từ business need, policy, technical constraint hay compliance requirement nào?', 'Source / rationale'),
            ('NFR', 'NFR-Q-04', 'Target hoặc constraint cụ thể cần đáp ứng là gì?', 'Target / constraint'),
            ('NFR', 'NFR-Q-05', 'Có threshold, limit, time window hoặc condition nào ảnh hưởng đến target không?', 'Measurement condition'),
            ('NFR', 'NFR-Q-06', 'Có mức tối thiểu, mức mong muốn hoặc tolerance nào cần phân biệt không?', 'Acceptance threshold'),
            ('NFR', 'NFR-Q-07', 'Kết quả cần được đo hoặc kiểm chứng như thế nào?', 'Validation method'),
            ('NFR', 'NFR-Q-08', 'NFR này phụ thuộc vào system, integration, data, infrastructure hoặc policy nào khác không?', 'NFR dependency'),
            ('NFR', 'NFR-Q-09', 'Có constraint hoặc decision nào chưa được xác nhận không?', 'Open NFR issue')
        ) AS t(module_code, question_id, question_text, required_information)
    LOOP
        IF EXISTS (
            SELECT 1 FROM public.definition_versions
            WHERE definition_type = 'QUESTION' AND definition_code = v_question.question_id
        ) THEN
            CONTINUE;
        END IF;

        INSERT INTO public.entity_identities (entity_id, entity_type)
        VALUES (gen_random_uuid(), 'DEFINITION')
        RETURNING entity_id INTO v_definition_id;

        INSERT INTO public.definition_versions (
            definition_id, definition_type, definition_code, version_no,
            applicability, definition_body, content_sha256, status, published_at
        ) VALUES (
            v_definition_id,
            'QUESTION',
            v_question.question_id,
            1,
            jsonb_build_object('module_code', v_question.module_code),
            jsonb_build_object(
                'question_text', v_question.question_text,
                'required_information', v_question.required_information,
                'source', 'Requirement_Framework.md, module ' || v_question.module_code || ', Ordered Elicitation Guide'
            ),
            encode(sha256(
                (v_question.question_id || v_question.question_text || v_question.required_information)::bytea
            ), 'hex'),
            'ACTIVE',
            now()
        );
    END LOOP;
END $$;

COMMIT;

-- ---------------------------------------------------------
-- Verification queries (run after commit, read-only):
--
--   SELECT table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE grantee = 'app_backend'
--     AND table_name IN ('module_applications', 'discovery_answers',
--                         'information_gaps', 'definition_versions')
--   ORDER BY table_name, privilege_type;
--   -- Expect: module_applications/discovery_answers/information_gaps
--   -- -> INSERT, SELECT, UPDATE; definition_versions -> SELECT only.
--   -- No DELETE anywhere.
--
--   SELECT definition_code, version_no, status,
--          definition_body->>'module_name' AS module_name
--   FROM public.definition_versions
--   WHERE definition_type = 'MODULE'
--   ORDER BY definition_code;
--   -- Expect exactly 7 rows: DATA, EXC, INT, NFR, PERM, PROC, RULE.
--
--   SELECT applicability->>'module_code' AS module_code, count(*)
--   FROM public.definition_versions
--   WHERE definition_type = 'QUESTION'
--   GROUP BY 1 ORDER BY 1;
--   -- Expect exactly: DATA=17, EXC=12, INT=16, NFR=9, PERM=14,
--   -- PROC=19, RULE=14 (101 total).
--
--   -- Spot-check one question's exact content against the source
--   -- document before trusting the rest:
--   SELECT definition_code, definition_body->>'question_text' AS question_text,
--          definition_body->>'required_information' AS required_information
--   FROM public.definition_versions
--   WHERE definition_type = 'QUESTION' AND definition_code = 'PROC-Q-12A';
-- ---------------------------------------------------------
