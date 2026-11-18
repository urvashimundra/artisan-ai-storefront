import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findUnitConflict } from '../../src/ai/unitConflict.js';

const MUG_TITLE = 'Blue Mug 300 ml';
const MUG_NOTES = 'Blue Mug: deep blue glaze with a white border, holds 350 ml.';
const sources = (...pairs) => pairs.map(([label, text]) => ({ label, text }));

describe('findUnitConflict', () => {
  it('flags the mug: the title says 300 ml, the notes say 350 ml, the answer picks one', () => {
    const conflict = findUnitConflict('The Blue Mug holds 350 ml.', sources(['product_description', MUG_TITLE], ['seller_notes', MUG_NOTES]), [MUG_TITLE]);
    assert.ok(conflict);
    assert.deepEqual(conflict.claims.map((claim) => claim.label), ['product_description', 'seller_notes']);
    assert.ok(conflict.claims[0].excerpt.includes('300 ml') && conflict.claims[1].excerpt.includes('350 ml'));
    assert.ok(MUG_NOTES.includes(conflict.claims[1].excerpt));
  });

  it('flags the same conflict whichever value the answer states', () => {
    assert.ok(findUnitConflict('The mug holds 300 ml.', sources(['product_description', MUG_TITLE], ['seller_notes', MUG_NOTES]), [MUG_TITLE]));
  });

  it('does not flag matching values, or the same quantity at another scale', () => {
    const same = sources(['product_description', MUG_TITLE], ['seller_notes', 'The mug holds 300 ml.']);
    assert.equal(findUnitConflict('The Blue Mug holds 300 ml.', same, [MUG_TITLE]), null);
    assert.equal(findUnitConflict('The Blue Mug holds 0.3 l.', same, [MUG_TITLE]), null);
  });

  it('does not flag unrelated figures of the same unit: delivery days against dispatch days', () => {
    const notes = sources(['product_description', MUG_TITLE], ['seller_notes', 'Delivery takes 4 to 7 days across India.\nThe mug ships in 3 to 5 working days.']);
    assert.equal(findUnitConflict('We dispatch in 3 to 5 working days.', notes, [MUG_TITLE]), null);
    assert.equal(findUnitConflict('The mug ships in 3 to 5 working days.', notes, [MUG_TITLE]), null);
    assert.equal(findUnitConflict('Delivery takes 4 to 7 days.', notes, [MUG_TITLE]), null);
  });

  it('does not flag unrelated figures of the same unit: burn hours against soak hours', () => {
    const titles = ['Lavender Candle'];
    const notes = sources(['product_description', 'Lavender Candle'], ['seller_notes', 'The candle burns about 4 hours, soak the wick for 2 hours before the first burn.']);
    assert.equal(findUnitConflict('The Lavender Candle burns about 4 hours.', notes, titles), null);
    assert.equal(findUnitConflict('Soak the candle wick for 2 hours first.', notes, titles), null);
  });

  it('does not flag list answers across products', () => {
    const titles = [MUG_TITLE, 'Tall Vase 500 ml'];
    const book = sources(['product_description', MUG_TITLE], ['product_description', 'Tall Vase 500 ml'], ['seller_notes', 'The vase holds 500 ml.']);
    assert.equal(findUnitConflict('We have the Blue Mug 300 ml, Tall Vase 500 ml.', book, titles), null);
    assert.equal(findUnitConflict('We have the Blue Mug 300 ml and the Tall Vase 500 ml.', book, titles), null);
  });

  it('ignores answers with no measurement or no product', () => {
    assert.equal(findUnitConflict('Yes, it is dishwasher safe.', sources(['seller_notes', MUG_NOTES]), [MUG_TITLE]), null);
    assert.equal(findUnitConflict('It holds 350 ml.', sources(['seller_notes', MUG_NOTES]), [MUG_TITLE]), null);
  });
});
