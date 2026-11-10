import { describe,it,expect } from 'vitest';
import { TRUE,FALSE,UNKNOWN,aggregateConditions,evaluateNativeLabelCondition } from './nativeLabelRuleConditions.js';
describe('native condition truth tables',()=>{
  for(const a of [TRUE,FALSE,UNKNOWN])for(const b of [TRUE,FALSE,UNKNOWN]){
    it(`combines ${a}, ${b} without boolean coercion`,()=>{
      expect(aggregateConditions([a,b],'AND')).toBe(a===FALSE||b===FALSE?FALSE:a===UNKNOWN||b===UNKNOWN?UNKNOWN:TRUE);
      expect(aggregateConditions([a,b],'OR')).toBe(a===TRUE||b===TRUE?TRUE:a===UNKNOWN||b===UNKNOWN?UNKNOWN:FALSE);
    });
  }
  it('distinguishes complete empty labels from missing evidence and direct membership',()=>{
    const has={field:'native_label',operator:'has',value:'parent'},not={...has,operator:'not_has'};
    expect(evaluateNativeLabelCondition(not,null)).toBe(UNKNOWN);
    expect(evaluateNativeLabelCondition(not,{availability:'known'})).toBe(UNKNOWN);
    expect(evaluateNativeLabelCondition(not,{availability:'known',labelIds:[]})).toBe(TRUE);
    expect(evaluateNativeLabelCondition(has,{availability:'known',labelIds:['child']})).toBe(FALSE);
  });
});
