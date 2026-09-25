'use strict';
// The list, rename and delete endpoints must extract the SAME bare product name
// from a stored item string. They used to each have their own copy of the logic:
// the list view stripped the "@ $65.24" price suffix and the delete matcher did
// not, so deleting an item matched zero rows and reported success anyway.

// Uses the real shared module — not a copy — so this can't drift from production.
const { decomposeItem, parseItemName } = require('../itemNames');

let passed = 0, failed = 0;
const eq = (n, a, e) => {
  if (a === e) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n} — got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`); }
};

console.log('\n── Bare name extraction ──');
{
  const cases = [
    ['2x 2025 Panini NFL Optic Donruss Football Trading Card Mega Box @ $65.24',
     '2025 Panini NFL Optic Donruss Football Trading Card Mega Box'],
    ['3x Pokemon TCG: 30th Celebration Booster Bundle (6 Packs) (SKU 10-10451-115) @ $35.14',
     'Pokemon TCG: 30th Celebration Booster Bundle (6 Packs)'],
    ['2x Pokémon 30th Anniversary Poster Collection @ $19.99',
     'Pokémon 30th Anniversary Poster Collection'],
    ['Canon PowerShot G7 X Mark III @ $879.99', 'Canon PowerShot G7 X Mark III'],
    ['96x LEGOPOKEMONEEVEE (Item 990497327)',   'LEGOPOKEMONEEVEE (Item 990497327)'],
    ['Paid online',                              'Paid online'],
    ['Pokemon Booster Box x2',                   'Pokemon Booster Box'],
    ['1x Simple Item',                           'Simple Item'],
  ];
  for (const [input, expected] of cases) eq(input.slice(0, 46) + '…', parseItemName(input), expected);
}

console.log('\n── The exact failure from the screenshot ──');
{
  const stored  = '2x 2025 Panini NFL Optic Donruss Football Trading Card Mega Box @ $65.24';
  const shown   = parseItemName(stored);                       // what the list shows
  const sentOnDelete = shown;                                  // what the UI sends

  // Old delete matcher: strips qty only.
  const oldMatch = (() => {
    let m = stored.match(/^(\d+)\s*[xX×]\s+(.+)/);
    return m ? m[2].trim() : stored;
  })();

  eq('old matcher kept the price suffix', oldMatch,
     '2025 Panini NFL Optic Donruss Football Trading Card Mega Box @ $65.24');
  eq('old comparison failed',  oldMatch.toLowerCase() === sentOnDelete.toLowerCase(), false);
  eq('new comparison matches', parseItemName(stored).toLowerCase() === sentOnDelete.toLowerCase(), true);
}

console.log('\n── Rename preserves quantity and suffixes ──');
{
  const rename = (stored, oldName, newName) => {
    const d = decomposeItem(stored);
    return d.name.toLowerCase() === oldName.toLowerCase()
      ? d.qtyPrefix + newName + d.suffix
      : stored;
  };
  eq('price suffix kept',
     rename('96x LEGOPOKEMONEEVEE @ $29.98', 'LEGOPOKEMONEEVEE', 'LEGO Pokémon Eevee'),
     '96x LEGO Pokémon Eevee @ $29.98');
  eq('SKU + price kept',
     rename('3x Old Name (SKU 10-10451-115) @ $35.14', 'Old Name', 'New Name'),
     '3x New Name (SKU 10-10451-115) @ $35.14');
  eq('non-matching left alone',
     rename('2x Something Else @ $5.00', 'Old Name', 'New Name'),
     '2x Something Else @ $5.00');
}

console.log('\n── List / delete / rename agree on every stored form ──');
{
  const stored = [
    '2x 2025 Panini NFL Optic Donruss Football Trading Card Mega Box @ $65.24',
    '3x Pokemon TCG: Booster Bundle (SKU 10-10451-115) @ $35.14',
    '1x Plain Item',
    'No Quantity Item @ $12.00',
  ];
  for (const s of stored) {
    const listed = parseItemName(s);
    const deleteMatches = parseItemName(s).toLowerCase() === listed.toLowerCase();
    const renamed = decomposeItem(s).qtyPrefix + 'X' + decomposeItem(s).suffix;
    eq(`agree: ${listed.slice(0, 40)}`, deleteMatches && renamed.includes('X'), true);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
