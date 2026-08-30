'use strict';
const r = require('./measurement-results.json');
const checks = {
  A_all_fallbacks_have_matching_declaration: r.A.fallbackCorrectDeclaration === r.A.fallbackUniqueFilename,
  A_public_basis_matches: r.A.basisMismatch.length === 0,
  A_yaml_attachment_counts_match: r.A.attachedMismatch.length === 0 && r.A.attachedRawTotal === r.A.attachedToolTotal,
  B_all_active_calls_lexically_seen: r.B.activeMisses.length === 0,
  B_reported_dangling_absent_on_disk: r.B.danglingDiskChecks.every(x => !x.caseInsensitiveExists),
  B_impact_axis_is_unreachable_for_reported_missing_targets: r.B.danglingImpactReproductions.every(x => !!x.response.error),
  C_accounting: r.C.truePositiveFieldLines + r.C.falsePositiveCount === r.C.predictedFieldLines &&
    r.C.truePositiveFieldLines + r.C.hiddenFieldCount === r.C.trueFieldLines,
  C_non_ctor_exact_rule: r.C.nonCtorExactKinds['in-method-body'] === r.C.nonCtorExactLines
};
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some(x => !x)) process.exit(1);
