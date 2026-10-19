const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  categoryToClassification,
  classifyFromSmartlead,
} = require('../src/services/smartlead-category');

describe('SmartLead numeric categories', () => {
  const mapped = [
    [1, 'INTERESTED'],
    [2, 'MEETING_PROPOSED'],
    [3, 'NOT_INTERESTED'],
    [4, 'REMOVE_ME'],
    [5, 'QUESTION'],
    [6, 'OOO'],
    [7, 'WRONG_PERSON'],
  ];

  for (const [id, want] of mapped) {
    it(`maps ${id} to ${want}`, () => {
      assert.equal(categoryToClassification(id), want);
      assert.equal(categoryToClassification(String(id)), want);
    });
  }

  it('unknown numbers and names do not become OTHER', () => {
    assert.equal(categoryToClassification(99), null);
    assert.equal(categoryToClassification('8'), null);
    assert.equal(categoryToClassification('Referred to colleague'), null);
    assert.equal(classifyFromSmartlead({ category: 99 }), null);
    assert.equal(classifyFromSmartlead({ lead_category_id: 8 }), null);
    assert.equal(classifyFromSmartlead({ lead_category: 'Team member' }), null);
  });

  it('reads a numeric category from webhook-shaped payloads', () => {
    assert.equal(classifyFromSmartlead({ category: 1 }).classification, 'INTERESTED');
    assert.equal(classifyFromSmartlead({ lead_category: { id: 2 } }).classification, 'MEETING_PROPOSED');
    assert.equal(classifyFromSmartlead({ lead_category_id: 5 }).classification, 'QUESTION');
  });
});
