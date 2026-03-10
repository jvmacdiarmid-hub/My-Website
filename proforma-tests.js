/**
 * NVCA Pro Forma — Test Suite
 * Browser: ProFormaEngine must be loaded as a global before this script.
 * Node.js: run via `node run-tests.js` which sets up globals before loading.
 *
 * Exposed as: window.ProFormaTests
 */
const ProFormaTests = (function () {
  'use strict';

  const E = ProFormaEngine; // alias

  // ============================================================
  // MINI ASSERTION LIBRARY
  // ============================================================

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected)
      throw new Error(`${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  function assertClose(actual, expected, message, pct = 0.001) {
    const diff    = Math.abs(actual - expected);
    const relDiff = Math.abs(expected) > 1e-12 ? diff / Math.abs(expected) : diff;
    if (relDiff > pct)
      throw new Error(
        `${message || 'assertClose'}: expected ~${expected} (±${(pct * 100).toFixed(3)}%), ` +
        `got ${actual} (off by ${(relDiff * 100).toFixed(4)}%)`
      );
  }

  function assertGt(actual, min, message) {
    if (actual <= min) throw new Error(`${message}: expected > ${min}, got ${actual}`);
  }

  function assertInRange(actual, lo, hi, message) {
    if (actual < lo || actual > hi)
      throw new Error(`${message}: expected [${lo}, ${hi}], got ${actual}`);
  }

  // ============================================================
  // TEST REGISTRY
  // ============================================================

  const registry = [];

  function test(name, category, fn) {
    registry.push({ name, category, fn });
  }

  // ============================================================
  // CATEGORY: UTILITIES
  // ============================================================

  test('roundShares — round method', 'Utilities', () => {
    assertEqual(E.roundShares(100.4), 100, 'round down');
    assertEqual(E.roundShares(100.5), 101, 'round up');
    assertEqual(E.roundShares(100.0), 100, 'exact integer');
  });

  test('roundShares — floor method', 'Utilities', () => {
    assertEqual(E.roundShares(100.99, 'floor'), 100, 'floor 100.99');
    assertEqual(E.roundShares(100.01, 'floor'), 100, 'floor 100.01');
    assertEqual(E.roundShares(100.0,  'floor'), 100, 'floor exact');
  });

  test('roundShares — ceil method', 'Utilities', () => {
    assertEqual(E.roundShares(100.01, 'ceil'), 101, 'ceil 100.01');
    assertEqual(E.roundShares(100.99, 'ceil'), 101, 'ceil 100.99');
    assertEqual(E.roundShares(100.0,  'ceil'), 100, 'ceil exact');
  });

  test('roundShares — none method returns decimal', 'Utilities', () => {
    const r = E.roundShares(100.25, 'none');
    assertClose(r, 100.25, 'none should not round');
  });

  test('daysBetween — one year', 'Utilities', () => {
    const days = E.daysBetween('2023-01-01', '2024-01-01');
    assertInRange(days, 364, 366, 'approx 365 days');
  });

  test('daysBetween — same date returns 0', 'Utilities', () => {
    assertEqual(E.daysBetween('2024-01-01', '2024-01-01'), 0, 'same date');
  });

  test('accruedInterest — 1yr at 6%', 'Utilities', () => {
    const interest = E.accruedInterest(1_000_000, 0.06, '2023-01-01', '2024-01-01');
    assertClose(interest, 60_000, '6% annual on $1M', 0.01);
  });

  test('accruedInterest — 6 months at 8%', 'Utilities', () => {
    const interest = E.accruedInterest(1_000_000, 0.08, '2024-01-01', '2024-07-01');
    assertInRange(interest, 38_000, 42_000, '~4% of $1M');
  });

  // ============================================================
  // CATEGORY: PPS CALCULATION
  // ============================================================

  test('PPS — simple case, no option expansion', 'PPS', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 2_000_000 },
    ];
    const calc = E.calculatePreMoneyOptionPoolExpansion(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0,  // no target → no expansion
    });
    assertEqual(calc.expansion, 0, 'no expansion');
    assertClose(calc.pps, 1.0, 'PPS = $1.00');
  });

  test('PPS — option pool expansion reduces PPS', 'PPS', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 500_000 },
    ];
    // Pre-money FD without expansion = 8.5M → PPS = $10M/8.5M ≈ $1.176
    // With expansion PPS must be lower (more shares in denominator)
    const calc = E.calculatePreMoneyOptionPoolExpansion(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0.15,
    });
    assert(calc.expansion > 0, 'expansion should be positive');
    assert(calc.pps < 10_000_000 / 8_500_000, 'PPS with expansion < PPS without');
  });

  test('PPS — option pool math verifies 15% target', 'PPS', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 500_000 },
    ];
    const calc = E.calculatePreMoneyOptionPoolExpansion(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0.15,
    });
    // Verify: post-money pool% should equal target
    const newShares  = 2_000_000 / calc.pps;
    const postFD     = calc.premoneyFD + newShares;
    const poolShares = 500_000 + calc.expansion;
    assertClose(poolShares / postFD, 0.15, 'post-money pool = 15%', 0.002);
  });

  test('PPS — error thrown when target is impossible', 'PPS', () => {
    const stakeholders = [{ name: 'Founders', type: 'common', shares: 1_000_000 }];
    let threw = false;
    try {
      E.calculatePreMoneyOptionPoolExpansion(stakeholders, {
        preMoneyValuation:   1_000_000,
        newInvestment:       10_000_000,  // 10x investment → denominator turns negative at high target
        optionPoolTargetPct: 0.95,        // 95% impossible
      });
    } catch (e) {
      threw = true;
    }
    assert(threw, 'should throw for impossible pool target');
  });

  // ============================================================
  // CATEGORY: SAFE CONVERSION
  // ============================================================

  test('SAFE — cap only, cap price < PPS', 'SAFE', () => {
    const safe = { name: 'SAFE', principal: 500_000, valuationCap: 5_000_000, discountRate: null, safeType: 'pre-money' };
    const pps  = 2.0;
    const premoneyFD = 10_000_000;
    // cap price = 5M / 10M = $0.50
    const r = E.convertSAFE(safe, pps, 20_000_000, premoneyFD);
    assertClose(r.conversionPPS, 0.50, 'cap price $0.50', 0.001);
    assertEqual(r.conversionBasis, 'cap', 'basis = cap');
    assertEqual(r.shares, 1_000_000, 'shares = 500k / $0.50 = 1M');
  });

  test('SAFE — discount only', 'SAFE', () => {
    const safe = { name: 'SAFE', principal: 500_000, valuationCap: null, discountRate: 0.8, safeType: 'pre-money' };
    const r = E.convertSAFE(safe, 2.0, 10_000_000, 5_000_000);
    assertClose(r.conversionPPS, 1.6, 'discount price = $1.60', 0.001);
    assertEqual(r.conversionBasis, 'discount', 'basis = discount');
    assertEqual(r.shares, 312_500, '500k / 1.6 = 312,500');
  });

  test('SAFE — cap & discount: cap wins (lower)', 'SAFE', () => {
    const safe = { name: 'SAFE', principal: 600_000, valuationCap: 6_000_000, discountRate: 0.8, safeType: 'pre-money' };
    const pps  = 2.0;
    const premoneyFD = 5_000_000;
    // cap price = 6M / 5M = $1.20,  discount = 2.0 * 0.8 = $1.60  → cap wins
    const r = E.convertSAFE(safe, pps, 10_000_000, premoneyFD);
    assertClose(r.conversionPPS, 1.2, 'cap price $1.20 wins', 0.001);
    assertEqual(r.conversionBasis, 'cap', 'basis = cap');
  });

  test('SAFE — cap & discount: discount wins (lower)', 'SAFE', () => {
    const safe = { name: 'SAFE', principal: 600_000, valuationCap: 12_000_000, discountRate: 0.8, safeType: 'pre-money' };
    const pps  = 2.0;
    const premoneyFD = 5_000_000;
    // cap price = 12M / 5M = $2.40 > PPS → capped at PPS $2.00
    // discount = 2.0 * 0.8 = $1.60 → discount wins
    const r = E.convertSAFE(safe, pps, 10_000_000, premoneyFD);
    assertClose(r.conversionPPS, 1.6, 'discount price $1.60 wins', 0.001);
    assertEqual(r.conversionBasis, 'discount', 'basis = discount');
  });

  test('SAFE — MFN (no cap, no discount) converts at PPS', 'SAFE', () => {
    const safe = { name: 'MFN SAFE', principal: 300_000, valuationCap: null, discountRate: null };
    const r = E.convertSAFE(safe, 1.5, 10_000_000, 8_000_000);
    assertClose(r.conversionPPS, 1.5, 'converts at PPS', 0.001);
    assertEqual(r.conversionBasis, 'pps', 'basis = pps');
    assertEqual(r.shares, 200_000, '300k / $1.50 = 200k shares');
  });

  test('SAFE — cap price cannot exceed PPS', 'SAFE', () => {
    // cap implies very high price (higher than PPS) → should clamp to PPS
    const safe = { name: 'SAFE', principal: 200_000, valuationCap: 100_000_000, discountRate: null, safeType: 'pre-money' };
    const pps  = 1.0;
    const premoneyFD = 10_000_000; // cap px = 100M/10M = $10 > PPS $1
    const r = E.convertSAFE(safe, pps, 10_000_000, premoneyFD);
    assertClose(r.conversionPPS, 1.0, 'clamped to PPS', 0.001);
  });

  test('SAFE — effective discount calculation', 'SAFE', () => {
    const safe = { name: 'SAFE', principal: 100_000, valuationCap: null, discountRate: 0.75 };
    const r = E.convertSAFE(safe, 2.0, 10_000_000, 5_000_000);
    assertClose(r.effectiveDiscount, 0.25, '25% effective discount', 0.001);
  });

  // ============================================================
  // CATEGORY: CONVERTIBLE NOTE
  // ============================================================

  test('Note — interest accrual (1yr, 6%)', 'Convertible Notes', () => {
    const note = { name: 'Note', type: 'note', principal: 1_000_000, interestRate: 0.06, issueDate: '2023-01-01', valuationCap: null, discountRate: null };
    const r = E.convertNote(note, 2.0, 10_000_000, 5_000_000, '2024-01-01');
    assertClose(r.interest, 60_000, 'interest ~$60k', 0.01);
    assertClose(r.conversionAmount, 1_060_000, 'conversion amount ~$1.06M', 0.005);
  });

  test('Note — converts at cap with interest included', 'Convertible Notes', () => {
    const note = { name: 'Note', type: 'note', principal: 1_000_000, interestRate: 0.06, issueDate: '2023-01-01', valuationCap: 8_000_000, discountRate: null };
    const premoneyFD = 10_000_000;
    const pps = 2.0;
    const r = E.convertNote(note, pps, 16_000_000, premoneyFD, '2024-01-01');
    // cap price = 8M / 10M = $0.80
    assertClose(r.conversionPPS, 0.8, 'cap price $0.80', 0.001);
    // shares = 1_060_000 / 0.80 = 1_325_000
    assertClose(r.shares, 1_325_000, 'shares from note with interest', 0.001);
  });

  test('Note — no accrual when dates missing', 'Convertible Notes', () => {
    const note = { name: 'Note', type: 'note', principal: 500_000, valuationCap: null, discountRate: null };
    const r = E.convertNote(note, 1.0, 5_000_000, 5_000_000, '2024-01-01');
    assertEqual(r.interest, 0, 'no interest without issueDate');
    assertEqual(r.conversionAmount, 500_000, 'conversion amount = principal');
  });

  test('Note — discount applied to total conversion amount', 'Convertible Notes', () => {
    const note = { name: 'Note', type: 'note', principal: 500_000, interestRate: 0.10, issueDate: '2023-07-01', valuationCap: null, discountRate: 0.8 };
    const r = E.convertNote(note, 2.0, 10_000_000, 5_000_000, '2024-07-01');
    assert(r.interest > 0, 'interest should accrue');
    assertClose(r.conversionPPS, 1.6, 'discount price on PPS', 0.005);
    assertClose(r.shares, r.conversionAmount / 1.6, 'shares = conversionAmount / discountPPS', 0.001);
  });

  // ============================================================
  // CATEGORY: OPTION POOL
  // ============================================================

  test('Option pool — pre-money method achieves target', 'Option Pool', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 500_000 },
    ];
    const result = E.buildProForma(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0.15,
      optionPoolMethod:    'pre-money',
      newShareClass:       'Series A Preferred',
    });
    assertClose(result.actualOptionPoolPct, 0.15, 'pool = 15%', 0.005);
  });

  test('Option pool — post-money method achieves target', 'Option Pool', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 200_000 },
    ];
    const result = E.buildProForma(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0.15,
      optionPoolMethod:    'post-money',
      newShareClass:       'Series A Preferred',
    });
    assertClose(result.actualOptionPoolPct, 0.15, 'post-money pool = 15%', 0.005);
  });

  test('Option pool — no expansion when pool already sufficient', 'Option Pool', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 6_000_000 },
      { name: 'Pool',     type: 'option', shares: 4_000_000 }, // already very large
    ];
    const result = E.buildProForma(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       1_000_000,
      optionPoolTargetPct: 0.10,
      optionPoolMethod:    'pre-money',
      newShareClass:       'Series A Preferred',
    });
    assertEqual(result.optionExpansion, 0, 'no expansion needed');
    assert(result.actualOptionPoolPct >= 0.10 - 0.005, 'pool >= target');
  });

  test('Option pool — zero target means no expansion', 'Option Pool', () => {
    const stakeholders = [{ name: 'Founders', type: 'common', shares: 10_000_000 }];
    const result = E.buildProForma(stakeholders, {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0,
      newShareClass:       'Series A Preferred',
    });
    assertEqual(result.optionExpansion, 0, 'no expansion');
  });

  // ============================================================
  // CATEGORY: FULL PRO FORMA BUILD
  // ============================================================

  test('Full build — seed round (template)', 'Full Pro Forma', () => {
    const t = E.buildTemplate('seed-round');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);

    assertGt(r.pps, 0, 'PPS > 0');
    assertGt(r.postFD, 0, 'post FD > 0');
    assertGt(r.newInvestorShares, 0, 'new investor shares > 0');
    assertEqual(r.convertedInstruments.length, 0, 'no convertibles in seed template');
  });

  test('Full build — new investor ownership ≈ investment/post-money', 'Full Pro Forma', () => {
    const t = E.buildTemplate('seed-round');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const investorPct    = r.newInvestorShares / r.postFD;
    const expectedPct    = r.newInvestment / r.postMoneyValuation;
    assertClose(investorPct, expectedPct, 'investor ownership ≈ $I / post-money', 0.02);
  });

  test('Full build — series A with SAFE (template)', 'Full Pro Forma', () => {
    const t = E.buildTemplate('series-a');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    assertEqual(r.convertedInstruments.length, 1, '1 SAFE converts');
    assertGt(r.convertedInstruments[0].shares, 0, 'SAFE converts to positive shares');
    assertEqual(r.convertedInstruments[0].conversionBasis, 'cap',
      'cap should win when cap price < round PPS');
  });

  test('Full build — 4 convertibles (template)', 'Full Pro Forma', () => {
    const t = E.buildTemplate('safe-conversion');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    assertEqual(r.convertedInstruments.length, 4, '4 instruments convert');
    for (const c of r.convertedInstruments) {
      assertGt(c.shares, 0, `${c.name} should convert to > 0 shares`);
    }
    const note = r.convertedInstruments.find(c => c.originalType === 'note');
    assert(note, 'convertible note found');
    assertGt(note.interest, 0, 'note has accrued interest');
  });

  test('Full build — post-money valuation = pre-money + investment', 'Full Pro Forma', () => {
    const t = E.buildTemplate('series-a');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    assertEqual(
      r.postMoneyValuation,
      r.preMoneyValuation + r.newInvestment,
      'post-money = pre + new investment'
    );
  });

  test('Full build — cap table shares sum to post FD', 'Full Pro Forma', () => {
    const t = E.buildTemplate('safe-conversion');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const capTotal = r.postRoundCap.reduce((sum, s) => sum + (s.shares || 0), 0);
    assertClose(capTotal, r.postFD, 'cap table sums to postFD', 0.0001);
  });

  test('Full build — ownership percentages sum to 100%', 'Full Pro Forma', () => {
    const t = E.buildTemplate('series-a');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const totalPct = r.ownershipTable.reduce((sum, row) => sum + row.pct, 0);
    assertClose(totalPct, 1.0, 'ownership sums to 100%', 0.001);
  });

  test('Full build — down round detected as error', 'Full Pro Forma', () => {
    const t = E.buildTemplate('down-round');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const a = E.analyzeProForma(r, t.stakeholders, t.roundConfig);
    const downRoundIssue = a.issues.find(i => i.code === 'DOWN_ROUND');
    assert(downRoundIssue, 'down-round should be detected');
  });

  // ============================================================
  // CATEGORY: ANALYZER
  // ============================================================

  test('Analyzer — clean seed round has no errors', 'Analyzer', () => {
    const t = E.buildTemplate('seed-round');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const a = E.analyzeProForma(r, t.stakeholders, t.roundConfig);
    assertEqual(a.summary.hasErrors, false, 'no errors for clean seed round');
  });

  test('Analyzer — option pool shuffle note present', 'Analyzer', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 100_000 },
    ];
    const roundConfig = {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0.20,
      optionPoolMethod:    'pre-money',
      newShareClass:       'Series A Preferred',
    };
    const r = E.buildProForma(stakeholders, roundConfig);
    const a = E.analyzeProForma(r, stakeholders, roundConfig);
    const note = a.notes.find(n => n.code === 'OPTION_POOL_SHUFFLE');
    assert(note, 'option pool shuffle note should be present');
  });

  test('Analyzer — SAFE cap conversion note present', 'Analyzer', () => {
    const t = E.buildTemplate('series-a');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const a = E.analyzeProForma(r, t.stakeholders, t.roundConfig);
    const note = a.notes.find(n => n.code === 'SAFE_CAP_CONVERSION');
    assert(note, 'SAFE cap conversion note present');
  });

  test('Analyzer — note interest note present', 'Analyzer', () => {
    const t = E.buildTemplate('safe-conversion');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const a = E.analyzeProForma(r, t.stakeholders, t.roundConfig);
    const note = a.notes.find(n => n.code === 'NOTE_INTEREST');
    assert(note, 'note interest note present');
  });

  test('Analyzer — participating preferred note present', 'Analyzer', () => {
    const stakeholders = [{ name: 'Founders', type: 'common', shares: 8_000_000 }];
    const roundConfig = {
      preMoneyValuation: 10_000_000,
      newInvestment:     2_000_000,
      newShareClass:     'Series A Preferred',
      participating:     true,
    };
    const r = E.buildProForma(stakeholders, roundConfig);
    const a = E.analyzeProForma(r, stakeholders, roundConfig);
    const note = a.notes.find(n => n.code === 'PARTICIPATING_PREFERRED');
    assert(note, 'participating preferred should be flagged');
  });

  test('Analyzer — status ok for clean pro forma', 'Analyzer', () => {
    const t = E.buildTemplate('seed-round');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const a = E.analyzeProForma(r, t.stakeholders, t.roundConfig);
    assertEqual(a.summary.status !== 'error', true, 'status should not be error');
  });

  test('Analyzer — large option pool triggers warning', 'Analyzer', () => {
    const stakeholders = [{ name: 'Founders', type: 'common', shares: 8_000_000 }];
    const roundConfig = {
      preMoneyValuation:   10_000_000,
      newInvestment:       2_000_000,
      optionPoolTargetPct: 0.30,  // 30% — over 25% threshold
      optionPoolMethod:    'pre-money',
      newShareClass:       'Series A Preferred',
    };
    const r = E.buildProForma(stakeholders, roundConfig);
    const a = E.analyzeProForma(r, stakeholders, roundConfig);
    const warn = a.warnings.find(w => w.code === 'POOL_LARGE');
    assert(warn, 'should warn about large option pool');
  });

  test('Analyzer — deep discount SAFE triggers warning', 'Analyzer', () => {
    const stakeholders = [
      { name: 'Founders', type: 'common', shares: 8_000_000 },
      { name: 'Pool',     type: 'option', shares: 1_000_000 },
      { name: 'SAFE',     type: 'safe', shares: 0, principal: 200_000, valuationCap: 500_000, discountRate: null, safeType: 'pre-money' },
    ];
    const roundConfig = {
      preMoneyValuation:   20_000_000,
      newInvestment:       5_000_000,
      newShareClass:       'Series A Preferred',
    };
    const r = E.buildProForma(stakeholders, roundConfig);
    const a = E.analyzeProForma(r, stakeholders, roundConfig);
    const warn = a.warnings.find(w => w.code === 'DEEP_DISCOUNT');
    assert(warn, 'deep discount SAFE should trigger warning');
  });

  // ============================================================
  // CATEGORY: ROUNDING EDGE CASES
  // ============================================================

  test('Rounding — different methods produce consistent results', 'Rounding', () => {
    const t = E.buildTemplate('series-a');
    const rRound = E.buildProForma(t.stakeholders, t.roundConfig, { roundingMethod: 'round' });
    const rFloor = E.buildProForma(t.stakeholders, t.roundConfig, { roundingMethod: 'floor' });
    const rCeil  = E.buildProForma(t.stakeholders, t.roundConfig, { roundingMethod: 'ceil'  });

    // All should produce valid positive PPS
    assertGt(rRound.pps, 0, 'round: PPS > 0');
    assertGt(rFloor.pps, 0, 'floor: PPS > 0');
    assertGt(rCeil.pps,  0, 'ceil: PPS > 0');

    // Floor shares <= round shares <= ceil shares
    assert(rFloor.newInvestorShares <= rCeil.newInvestorShares, 'floor ≤ ceil shares');
  });

  test('Rounding — proceeds within 1% of investment for typical round', 'Rounding', () => {
    const t = E.buildTemplate('seed-round');
    const r = E.buildProForma(t.stakeholders, t.roundConfig);
    const proceeds = r.pps * r.newInvestorShares;
    assertClose(proceeds, r.newInvestment, 'proceeds ≈ investment', 0.01);
  });

  // ============================================================
  // TEST RUNNER
  // ============================================================

  /**
   * Run all registered tests.
   * @param {Function} [onProgress]  called with result after each test
   * @returns {Promise<Object[]>}    array of test results
   */
  async function runAll(onProgress) {
    const results = [];
    for (const t of registry) {
      const result = await runOne(t.name);
      results.push(result);
      if (onProgress) onProgress(result);
    }
    return results;
  }

  /**
   * Run tests matching a category.
   * @param {string} category
   * @param {Function} [onProgress]
   */
  async function runCategory(category, onProgress) {
    const results = [];
    for (const t of registry.filter(x => x.category === category)) {
      const result = await runOne(t.name);
      results.push(result);
      if (onProgress) onProgress(result);
    }
    return results;
  }

  /**
   * Run a single test by name.
   * @param {string} name
   * @returns {Promise<Object>}
   */
  async function runOne(name) {
    const t = registry.find(x => x.name === name);
    if (!t) return { name, category: '?', status: 'error', error: `Test "${name}" not found`, duration: 0 };

    const start = performance.now();
    let status = 'pass', error = null;
    try {
      await t.fn();
    } catch (e) {
      status = 'fail';
      error  = e.message;
    }
    return { name: t.name, category: t.category, status, error, duration: +(performance.now() - start).toFixed(2) };
  }

  /** Unique categories in registration order. */
  function getCategories() {
    return [...new Set(registry.map(t => t.category))];
  }

  return {
    registry,
    runAll,
    runOne,
    runCategory,
    getCategories,
    // Exposed helpers so custom tests can reuse them
    assert,
    assertEqual,
    assertClose,
    assertGt,
    assertInRange,
  };
})();

// CommonJS export for Node.js CLI runner
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProFormaTests;
}
