const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatCampaignDisplay,
  campaignNameFromReply,
} = require('../src/utils/campaign-display');

describe('campaign-display', () => {
  it('prefers the human campaign name over a bare id', () => {
    assert.equal(
      formatCampaignDisplay('SalesGlider Staffing', '3739758'),
      'SalesGlider Staffing (3739758)'
    );
    assert.equal(formatCampaignDisplay('SalesGlider Staffing', null), 'SalesGlider Staffing');
    assert.equal(formatCampaignDisplay(null, '3739758'), 'Campaign 3739758');
  });

  it('reads campaign_name from the reply row or heyreach meta', () => {
    assert.equal(
      campaignNameFromReply({ campaign_name: 'SalesGlider Trades Airpods' }),
      'SalesGlider Trades Airpods'
    );
    assert.equal(
      campaignNameFromReply({
        thread_context: { heyreach: { campaignName: 'LinkedIn Warm' } },
      }),
      'LinkedIn Warm'
    );
  });
});
