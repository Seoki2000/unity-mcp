'use strict';

// Safe adversarial reproductions: no Unity or target-repository files are changed.
const path = require('path');
// 인덱스 캐시를 진짜 홈에 안 쓰도록 격리한다.
process.env.USERPROFILE = process.env.PROBE_PROFILE || path.join(__dirname, '.profile');
process.env.UNITY_MCP_PROJECT = process.env.UNITY_MCP_PROJECT || 'C:/Unity/MainProject';
const tools = require(path.join(__dirname, '..', '..', 'Bridge/index/tools'));
const call = (n, a) => JSON.parse(tools.callLocalTool(n, a, 3000).content[0].text);

// Exact filename-fallback decision, on a synthetic namespace collision.
const syntheticAssets = ['Assets/Wrong/Widget.cs'];
const requested = 'Right.Namespace.Widget';
const short = requested.split('.').pop();
const hits = syntheticAssets.filter(p => p.split('/').pop() === short + '.cs');
const declarationInChosenFile = 'namespace Wrong.Namespace { class Widget {} }';
const syntheticA = {
  requested,
  chosen: hits.length === 1 ? hits[0] : null,
  chosenSource: declarationInChosenFile,
  wrong: hits.length === 1 && !declarationInChosenFile.includes('namespace Right.Namespace')
};

const probes = {
  syntheticA,
  nestedCollision: call('unity_impact_analysis', { target: 'Segment' }),
  missingAssetImpact: call('unity_impact_analysis', { target: 'Assets/5.VFX/Common/FX_Hit_Spark.prefab' }),
  constructorObjectInitializer: call('unity_explain_compile_errors', { errors: [
    { file: 'Assets/1.Scripts/Monster/Boss/BossDataSO.cs', line: 106, message: 'probe' }
  ]}),
  attributedField: call('unity_explain_compile_errors', { errors: [
    { file: 'Assets/1.Scripts/BT/Actions/Animation/GetAnimClipPlayTimeAction.cs', line: 11, message: 'probe' }
  ]}),
  nestedField: call('unity_explain_compile_errors', { errors: [
    { file: 'Assets/1.Scripts/Effects/EffectManager.cs', line: 654, message: 'probe' }
  ]})
};
console.log(JSON.stringify(probes, null, 2));
