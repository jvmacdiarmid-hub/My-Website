/**
 * NVCA Pro Forma Engine v1.0
 * Builds and analyzes venture capital financing pro formas
 * following NVCA model documents and standard VC practice.
 *
 * Exposed as: window.ProFormaEngine
 */
const ProFormaEngine = (function () {
  'use strict';

  // ============================================================
  // FORMATTING HELPERS
  // ============================================================

  function formatCurrency(n, decimals = 0) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }).format(n);
  }

  function formatNumber(n, decimals = 0) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  }

  function formatPct(n, decimals = 2) {
    return (n * 100).toFixed(decimals) + '%';
  }

  // ============================================================
  // ROUNDING
  // ============================================================

  /**
   * Round shares according to specified method.
   * @param {number} shares
   * @param {'round'|'floor'|'ceil'|'none'} method
   */
  function roundShares(shares, method = 'round') {
    switch (method) {
      case 'floor': return Math.floor(shares);
      case 'ceil':  return Math.ceil(shares);
      case 'none':  return shares;
      default:      return Math.round(shares);
    }
  }

  // ============================================================
  // DATE / INTEREST HELPERS
  // ============================================================

  function daysBetween(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return Math.max(0, (d2 - d1) / (1000 * 60 * 60 * 24));
  }

  /**
   * Compute simple interest for a convertible note.
   * @param {number} principal
   * @param {number} annualRate  e.g. 0.06 for 6%
   * @param {string} issueDate   ISO date string
   * @param {string} closingDate ISO date string
   */
  function accruedInterest(principal, annualRate, issueDate, closingDate) {
    const days = daysBetween(issueDate, closingDate || new Date().toISOString());
    return principal * annualRate * (days / 365);
  }

  // ============================================================
  // CAP TABLE AGGREGATORS
  // ============================================================

  /**
   * Sum shares for given types from a stakeholder array.
   * @param {Object[]} stakeholders
   * @param {string[]} types
   */
  function getFullyDiluted(stakeholders, types = ['common', 'preferred', 'option', 'warrant']) {
    return stakeholders
      .filter(s => types.includes(s.type))
      .reduce((sum, s) => sum + (s.shares || 0), 0);
  }

  /** Return total option pool shares (type === 'option'). */
  function getOptionPool(stakeholders) {
    return stakeholders
      .filter(s => s.type === 'option')
      .reduce((sum, s) => sum + (s.shares || 0), 0);
  }

  // ============================================================
  // OPTION POOL EXPANSION (PRE-MONEY "SHUFFLE")
  // ============================================================

  /**
   * Solve for required option pool expansion when using the pre-money method.
   *
   * Goal: after closing, option_pool / post_FD == T
   *
   * Closed-form derivation:
   *   Let S0   = existing FD shares (includes existing option pool)
   *       E0   = existing option pool
   *       P    = pre-money valuation
   *       I    = new investment
   *       T    = target option % of post-money FD
   *       E    = expansion (unknown)
   *       X    = S0 + E  (pre-money FD after expansion)
   *       PPS  = P / X
   *       N    = I / PPS = I*X / P
   *       FD'  = X + N = X*(1 + I/P)
   *       pool'= E0 + E = E0 + (X - S0)
   *
   *   T = (E0 + X - S0) / (X*(1+I/P))
   *   X*(1+I/P)*T = E0 + X - S0
   *   X - T*(1+I/P)*X = S0 - E0
   *   X = (S0 - E0) / (1 - T*(1+I/P))
   *   E = X - S0
   *
   * @returns {{ expansion, premoneyFD, pps, existingPool }}
   */
  function calculatePreMoneyOptionPoolExpansion(stakeholders, roundConfig) {
    const { preMoneyValuation, newInvestment, optionPoolTargetPct: T } = roundConfig;

    const S0 = getFullyDiluted(stakeholders);
    const E0 = getOptionPool(stakeholders);

    if (!T || T <= 0) {
      const pps = preMoneyValuation / S0;
      return { expansion: 0, premoneyFD: S0, pps, existingPool: E0 };
    }

    const denominator = 1 - T * (1 + newInvestment / preMoneyValuation);

    if (denominator <= 0) {
      throw new Error(
        `Option pool target (${formatPct(T)}) is mathematically impossible with the given investment size. ` +
        `Reduce the target or reduce the investment-to-valuation ratio.`
      );
    }

    const X = (S0 - E0) / denominator;
    const expansion = Math.max(0, X - S0);
    const premoneyFD = S0 + expansion;
    const pps = preMoneyValuation / premoneyFD;

    return { expansion, premoneyFD, pps, existingPool: E0 };
  }

  // ============================================================
  // SAFE CONVERSION
  // ============================================================

  /**
   * Convert a SAFE to shares.
   *
   * Supports:
   *   - Cap only (valuationCap, no discountRate)
   *   - Discount only (discountRate, no valuationCap)
   *   - Cap & discount (takes the more favourable — lower — price)
   *   - MFN / no terms (converts at round PPS)
   *   - Pre-money and post-money SAFEs (post-money cap treated as cap/premoneyFD)
   *
   * @param {Object}  safe
   * @param {number}  pps              round PPS
   * @param {number}  preMoneyValuation
   * @param {number}  premoneyFD       pre-money FD share count (after pool expansion)
   * @param {'round'|'floor'|'ceil'|'none'} roundingMethod
   */
  function convertSAFE(safe, pps, preMoneyValuation, premoneyFD, roundingMethod = 'round') {
    const { principal, valuationCap, discountRate, safeType } = safe;

    const candidates = [];

    if (valuationCap) {
      // Cap price: valuation cap / pre-money FD shares
      const capPrice = valuationCap / premoneyFD;
      candidates.push({ type: 'cap', price: capPrice });
    }

    if (discountRate) {
      // Discount price: round PPS × discountRate  (e.g. 0.80 = 20% discount)
      const discountPrice = pps * discountRate;
      candidates.push({ type: 'discount', price: discountPrice });
    }

    // Fallback: converts at round PPS
    if (candidates.length === 0) {
      candidates.push({ type: 'pps', price: pps });
    }

    // SAFE holder gets the LOWEST price (most shares)
    let best = candidates.reduce((min, c) => (c.price < min.price ? c : min), candidates[0]);

    // Cannot convert at a price higher than the round PPS
    if (best.price > pps) best = { type: 'pps', price: pps };

    const conversionPPS = best.price;
    const shares = roundShares(principal / conversionPPS, roundingMethod);

    return {
      shares,
      conversionPPS,
      conversionBasis: best.type,
      principal,
      effectiveDiscount: pps > 0 ? (1 - conversionPPS / pps) : 0,
    };
  }

  // ============================================================
  // CONVERTIBLE NOTE CONVERSION
  // ============================================================

  /**
   * Convert a convertible note to shares.
   * Adds accrued interest to principal before applying cap/discount logic.
   *
   * @param {Object} note
   * @param {number} pps
   * @param {number} preMoneyValuation
   * @param {number} premoneyFD
   * @param {string} closingDate       ISO date string
   * @param {'round'|'floor'|'ceil'|'none'} roundingMethod
   */
  function convertNote(note, pps, preMoneyValuation, premoneyFD, closingDate, roundingMethod = 'round') {
    const { principal, interestRate, issueDate, valuationCap, discountRate } = note;

    const interest = (interestRate && issueDate)
      ? accruedInterest(principal, interestRate, issueDate, closingDate)
      : 0;

    const conversionAmount = principal + interest;

    // Re-use SAFE logic with conversionAmount as principal
    const proxyNote = {
      principal: conversionAmount,
      valuationCap,
      discountRate,
      safeType: 'pre-money',
    };

    const result = convertSAFE(proxyNote, pps, preMoneyValuation, premoneyFD, roundingMethod);

    return {
      ...result,
      principal,
      interest,
      conversionAmount,
    };
  }

  // ============================================================
  // MAIN PRO FORMA BUILDER
  // ============================================================

  /**
   * Build a complete NVCA-style financing pro forma.
   *
   * @param {Object[]} preRoundCap   - existing cap table (see typedef below)
   * @param {Object}   roundConfig   - new round parameters
   * @param {Object}   [options]     - { roundingMethod }
   *
   * Stakeholder shape:
   *   { name, type ('common'|'preferred'|'option'|'warrant'|'safe'|'note'),
   *     shares,
   *     // preferred only:
   *     series, originalIssuePrice, liquidationMultiple, participating, participationCap,
   *     // option/warrant only:
   *     strikePrice,
   *     // safe only:
   *     principal, valuationCap, discountRate, safeType ('pre-money'|'post-money'),
   *     // note only:
   *     principal, interestRate, issueDate, valuationCap, discountRate }
   *
   * RoundConfig shape:
   *   { roundName, preMoneyValuation, newInvestment,
   *     optionPoolTargetPct, optionPoolMethod ('pre-money'|'post-money'),
   *     newShareClass, newInvestorName,
   *     liquidationMultiple, participating, participationCap,
   *     closingDate }
   *
   * @returns {ProFormaResult}
   */
  function buildProForma(preRoundCap, roundConfig, options = {}) {
    const {
      roundName        = 'New Round',
      preMoneyValuation,
      newInvestment,
      optionPoolTargetPct = 0,
      optionPoolMethod    = 'pre-money',
      newShareClass       = 'New Preferred',
      newInvestorName     = 'New Investors',
      liquidationMultiple = 1,
      participating       = false,
      participationCap    = null,
      closingDate         = new Date().toISOString(),
    } = roundConfig;

    const { roundingMethod = 'round' } = options;
    const issues   = [];
    const warnings = [];

    // ---- Step 1: Determine pre-money FD and PPS ----
    let optionExpansion = 0;
    let premoneyFD;
    let pps;

    if (optionPoolTargetPct > 0 && optionPoolMethod === 'pre-money') {
      try {
        const calc  = calculatePreMoneyOptionPoolExpansion(preRoundCap, roundConfig);
        optionExpansion = roundShares(calc.expansion, roundingMethod);
        premoneyFD  = getFullyDiluted(preRoundCap) + optionExpansion;
        pps         = preMoneyValuation / premoneyFD;
      } catch (e) {
        issues.push({ severity: 'error', code: 'POOL_CALC_ERROR', message: e.message });
        premoneyFD = getFullyDiluted(preRoundCap);
        pps        = preMoneyValuation / premoneyFD;
      }
    } else {
      premoneyFD = getFullyDiluted(preRoundCap);
      pps        = preMoneyValuation / premoneyFD;
    }

    // ---- Step 2: Convert SAFEs and notes at computed PPS ----
    const convertedInstruments = [];
    for (const s of preRoundCap) {
      if (s.type !== 'safe' && s.type !== 'note') continue;

      let conversion;
      if (s.type === 'safe') {
        conversion = convertSAFE(s, pps, preMoneyValuation, premoneyFD, roundingMethod);
      } else {
        conversion = convertNote(s, pps, preMoneyValuation, premoneyFD, closingDate, roundingMethod);
      }

      convertedInstruments.push({
        ...s,
        ...conversion,
        originalType:       s.type,
        type:               'preferred',
        series:             s.series || (roundName + ' Converted'),
        originalIssuePrice: conversion.conversionPPS,
        liquidationMultiple: s.liquidationMultiple || 1,
        participating:      s.participating || false,
        participationCap:   s.participationCap || null,
      });
    }

    // ---- Step 3: New investor share count ----
    const newInvestorShares = roundShares(newInvestment / pps, roundingMethod);

    // ---- Step 4: Build post-round cap table ----
    const postRoundCap = [];

    // Carry over existing stakeholders (SAFEs/notes have been replaced)
    for (const s of preRoundCap) {
      if (s.type === 'safe' || s.type === 'note') continue;
      postRoundCap.push({ ...s });
    }

    // Apply option pool expansion (pre-money method)
    if (optionExpansion > 0) {
      const poolEntry = postRoundCap.find(
        s => s.type === 'option' && /pool/i.test(s.name)
      );
      if (poolEntry) {
        poolEntry.shares += optionExpansion;
        poolEntry._expansion = optionExpansion;
      } else {
        postRoundCap.push({ name: 'Option Pool (Expanded)', type: 'option', shares: optionExpansion, _expansion: optionExpansion });
      }
    }

    // Add converted SAFEs/notes
    for (const c of convertedInstruments) postRoundCap.push(c);

    // Add new round investors
    postRoundCap.push({
      name:               newInvestorName,
      type:               'preferred',
      shares:             newInvestorShares,
      series:             newShareClass,
      originalIssuePrice: pps,
      liquidationMultiple,
      participating,
      participationCap,
    });

    // Post-money option pool expansion (if method is post-money)
    // Solve: (curPool + expansion) / (tempFD + expansion) = T
    //   → expansion = (T*tempFD - curPool) / (1 - T)
    if (optionPoolTargetPct > 0 && optionPoolMethod === 'post-money') {
      const tempFD    = getFullyDiluted(postRoundCap);
      const curPool   = getOptionPool(postRoundCap);
      const rawExp    = (optionPoolTargetPct * tempFD - curPool) / (1 - optionPoolTargetPct);
      const expansion = Math.max(0, roundShares(rawExp, roundingMethod));
      if (expansion > 0) {
        const poolEntry = postRoundCap.find(s => s.type === 'option' && /pool/i.test(s.name));
        if (poolEntry) { poolEntry.shares += expansion; poolEntry._expansion = (poolEntry._expansion || 0) + expansion; }
        else postRoundCap.push({ name: 'Option Pool (Post-money)', type: 'option', shares: expansion, _expansion: expansion });
      }
    }

    // ---- Step 5: Post-money metrics ----
    const postFD               = getFullyDiluted(postRoundCap);
    const postMoneyValuation   = preMoneyValuation + newInvestment;
    const actualOptionPoolPct  = postFD > 0 ? getOptionPool(postRoundCap) / postFD : 0;

    // Ownership with pre/post dilution
    const preRoundFDforPct = getFullyDiluted(preRoundCap);
    const ownershipTable = postRoundCap.map(s => ({
      name:    s.name,
      type:    s.type,
      series:  s.series || null,
      shares:  s.shares || 0,
      pct:     postFD > 0 ? (s.shares || 0) / postFD : 0,
    }));

    return {
      // Inputs (kept for analysis)
      preRoundCap,
      roundConfig,

      // Key outputs
      pps,
      premoneyFD,
      postFD,
      preMoneyValuation,
      postMoneyValuation,
      newInvestment,
      newInvestorShares,
      optionExpansion,
      actualOptionPoolPct,

      // Tables
      postRoundCap,
      convertedInstruments,
      ownershipTable,

      // Flags
      issues,
      warnings,

      // Meta
      roundName,
      closingDate,
    };
  }

  // ============================================================
  // ANALYZER
  // ============================================================

  /**
   * Analyze a built pro forma result for issues, warnings, and informational notes.
   * @param {Object} result    return value of buildProForma()
   * @param {Object[]} preRoundCap
   * @param {Object}   roundConfig
   * @returns {{ issues, warnings, notes, summary }}
   */
  function analyzeProForma(result, preRoundCap, roundConfig) {
    const issues   = [...result.issues];
    const warnings = [...result.warnings];
    const notes    = [];

    const {
      pps, premoneyFD, postFD, preMoneyValuation,
      newInvestment, newInvestorShares,
      actualOptionPoolPct, optionExpansion,
      convertedInstruments, postRoundCap,
    } = result;

    const {
      optionPoolTargetPct = 0,
      optionPoolMethod    = 'pre-money',
    } = roundConfig;

    // ---- PPS sanity ----
    if (!isFinite(pps) || pps <= 0) {
      issues.push({ severity: 'error', code: 'PPS_INVALID',
        message: 'Price per share is zero, negative, or undefined. Verify pre-money valuation and share counts.' });
    } else {
      if (pps > 500) warnings.push({ severity: 'warning', code: 'PPS_HIGH',
        message: `PPS of ${formatCurrency(pps, 4)} is very high. Consider verifying share counts or using a lower share denomination.` });
      if (pps < 0.0001) warnings.push({ severity: 'warning', code: 'PPS_LOW',
        message: `PPS of ${formatCurrency(pps, 6)} is very low. Consider a reverse stock split or verify share counts.` });
    }

    // ---- Fully diluted share count ----
    if (premoneyFD <= 0) {
      issues.push({ severity: 'error', code: 'FD_INVALID',
        message: 'Pre-money fully diluted share count is zero or negative.' });
    }

    // ---- Option pool ----
    if (optionPoolTargetPct > 0) {
      const poolDiff = Math.abs(actualOptionPoolPct - optionPoolTargetPct);
      if (poolDiff > 0.002) {
        warnings.push({ severity: 'warning', code: 'POOL_PCT_MISMATCH',
          message: `Actual option pool (${formatPct(actualOptionPoolPct)}) differs from target ` +
                   `(${formatPct(optionPoolTargetPct)}) by ${formatPct(poolDiff)}. Likely caused by share rounding.` });
      }

      if (optionPoolMethod === 'pre-money' && optionExpansion > 0) {
        const founderShares = preRoundCap
          .filter(s => s.type === 'common')
          .reduce((sum, s) => sum + (s.shares || 0), 0);

        notes.push({ code: 'OPTION_POOL_SHUFFLE',
          message: `Option pool shuffle: ${formatNumber(optionExpansion)} shares created pre-money (PPS = ` +
                   `${formatCurrency(pps, 4)}), diluting existing holders before new investment. ` +
                   `Effective pre-money valuation for founders = ${formatCurrency(preMoneyValuation * (premoneyFD - optionExpansion) / premoneyFD)}.` });

        if (founderShares > 0 && premoneyFD > 0) {
          const shuffleDilutionPct = optionExpansion / premoneyFD;
          notes.push({ code: 'SHUFFLE_DILUTION',
            message: `Pool shuffle causes ~${formatPct(shuffleDilutionPct)} additional dilution to ` +
                     `pre-existing shareholders.` });
        }
      }

      if (optionPoolTargetPct > 0.25) {
        warnings.push({ severity: 'warning', code: 'POOL_LARGE',
          message: `Option pool target of ${formatPct(optionPoolTargetPct)} exceeds 25% — unusually large. Verify intent.` });
      }
    }

    // ---- Convertible instrument conversions ----
    for (const conv of convertedInstruments) {
      if (conv.effectiveDiscount > 0.5) {
        warnings.push({ severity: 'warning', code: 'DEEP_DISCOUNT',
          message: `${conv.name} converting at a ${formatPct(conv.effectiveDiscount)} discount to round PPS ` +
                   `(${formatCurrency(conv.conversionPPS, 4)} vs ${formatCurrency(pps, 4)}). Confirm conversion terms.` });
      }

      const basis = conv.conversionBasis;
      if (basis === 'cap') {
        notes.push({ code: 'SAFE_CAP_CONVERSION',
          message: `${conv.name}: converting on valuation cap ` +
                   `(${formatCurrency(conv.valuationCap)}) → ${formatCurrency(conv.conversionPPS, 4)}/share ` +
                   `vs round PPS ${formatCurrency(pps, 4)}/share.` });
      } else if (basis === 'discount') {
        notes.push({ code: 'SAFE_DISCOUNT_CONVERSION',
          message: `${conv.name}: converting on discount ` +
                   `(${formatPct(1 - (conv.discountRate || 0))}) → ${formatCurrency(conv.conversionPPS, 4)}/share.` });
      } else if (basis === 'pps') {
        notes.push({ code: 'SAFE_PPS_CONVERSION',
          message: `${conv.name}: no cap or discount applied — converting at round PPS ${formatCurrency(pps, 4)}/share.` });
      }

      if (conv.originalType === 'note' && conv.interest > 0) {
        notes.push({ code: 'NOTE_INTEREST',
          message: `${conv.name}: accrued interest ${formatCurrency(conv.interest)} added to principal ` +
                   `${formatCurrency(conv.principal)} → conversion amount ${formatCurrency(conv.conversionAmount)}.` });
      }

      if (conv.valuationCap && conv.discountRate) {
        const capPx = conv.valuationCap / premoneyFD;
        const disPx = pps * conv.discountRate;
        if (Math.abs(capPx - disPx) / pps < 0.02) {
          notes.push({ code: 'CAP_DISCOUNT_NEAR_EQUAL',
            message: `${conv.name}: cap price and discount price are nearly equal (within 2%). Both mechanisms yield similar outcomes.` });
        }
      }
    }

    // ---- Rounding accuracy ----
    const actualProceeds = pps * newInvestorShares;
    const roundingDeviation = newInvestment > 0 ? Math.abs(actualProceeds - newInvestment) / newInvestment : 0;
    if (roundingDeviation > 0.005) {
      warnings.push({ severity: 'warning', code: 'ROUNDING_PROCEEDS',
        message: `Share rounding means new investors pay ${formatCurrency(actualProceeds)} vs intended ` +
                 `${formatCurrency(newInvestment)} (${formatPct(roundingDeviation)} error). ` +
                 `Consider adjusting share count by ${Math.round(Math.abs(newInvestment - actualProceeds) / pps)} shares.` });
    }

    // ---- Valuation consistency ----
    if (newInvestorShares > 0 && postFD > 0) {
      const impliedPreMoney = newInvestment / (newInvestorShares / postFD) - newInvestment;
      const valn_err = preMoneyValuation > 0 ? Math.abs(impliedPreMoney - preMoneyValuation) / preMoneyValuation : 0;
      if (valn_err > 0.005) {
        warnings.push({ severity: 'warning', code: 'VALUATION_MISMATCH',
          message: `Implied pre-money (${formatCurrency(impliedPreMoney)}) differs from stated ` +
                   `(${formatCurrency(preMoneyValuation)}) by ${formatPct(valn_err)}. ` +
                   `Primarily caused by share rounding and SAFE/note dilution.` });
      }
    }

    // ---- Cap table integrity ----
    const tableTotal = postRoundCap.reduce((sum, s) => sum + (s.shares || 0), 0);
    if (Math.abs(tableTotal - postFD) > 1) {
      issues.push({ severity: 'error', code: 'SHARE_COUNT_MISMATCH',
        message: `Cap table total (${formatNumber(tableTotal)}) ≠ computed FD shares (${formatNumber(postFD)}). Formula error in share aggregation.` });
    }

    // ---- Liquidation preferences ----
    const preferred = postRoundCap.filter(s => s.type === 'preferred');
    const participating = preferred.filter(s => s.participating);
    if (participating.length > 0) {
      notes.push({ code: 'PARTICIPATING_PREFERRED',
        message: `Participating preferred: ${participating.map(s => s.name).join(', ')}. ` +
                 `These holders receive liquidation preference AND then participate pro-rata in remaining proceeds.` });
    }

    const highMultiples = preferred.filter(s => (s.liquidationMultiple || 1) > 1);
    if (highMultiples.length > 0) {
      notes.push({ code: 'HIGH_LIQUIDATION_MULTIPLE',
        message: `Non-standard liquidation multiples: ` +
                 `${highMultiples.map(s => `${s.name} (${s.liquidationMultiple}x)`).join(', ')}.` });
    }

    // ---- Anti-dilution (informational) ----
    const priorPreferred = preRoundCap.filter(s => s.type === 'preferred' && s.originalIssuePrice);
    const downRound = priorPreferred.some(s => s.originalIssuePrice > pps);
    if (downRound) {
      issues.push({ severity: 'error', code: 'DOWN_ROUND',
        message: `New PPS (${formatCurrency(pps, 4)}) is below the original issue price of one or more prior preferred series. ` +
                 `This is a down-round — anti-dilution provisions may be triggered (broad-based WA or full ratchet). ` +
                 `Review existing investor rights.` });
    }

    // ================================================================
    // SECTION 1 — PRE-MONEY CAP TABLE INTEGRITY
    // ================================================================

    // Fully-diluted composition note
    const preCommon    = preRoundCap.filter(s => s.type === 'common').reduce((sum, s) => sum + (s.shares || 0), 0);
    const prePreferred = preRoundCap.filter(s => s.type === 'preferred').reduce((sum, s) => sum + (s.shares || 0), 0);
    const preOptions   = preRoundCap.filter(s => s.type === 'option').reduce((sum, s) => sum + (s.shares || 0), 0);
    const preWarrants  = preRoundCap.filter(s => s.type === 'warrant').reduce((sum, s) => sum + (s.shares || 0), 0);
    const preSAFEs     = preRoundCap.filter(s => s.type === 'safe').length;
    const preNotes     = preRoundCap.filter(s => s.type === 'note').length;
    notes.push({ code: 'FD_COMPOSITION',
      message:
        `Pre-money FD breakdown — Common: ${formatNumber(preCommon)}, ` +
        `Preferred: ${formatNumber(prePreferred)}, ` +
        `Options: ${formatNumber(preOptions)}, ` +
        `Warrants: ${formatNumber(preWarrants)}` +
        (preSAFEs ? `, ${preSAFEs} SAFE(s) pending conversion` : '') +
        (preNotes ? `, ${preNotes} note(s) pending conversion` : '') +
        `. Pre-money FD (after any pool expansion): ${formatNumber(premoneyFD)}.`,
    });

    // Warrants — net exercise dilution risk
    if (preWarrants > 0) {
      warnings.push({ severity: 'warning', code: 'WARRANT_PRESENT',
        message:
          `${formatNumber(preWarrants)} warrant shares are included in the pre-money FD count. ` +
          `Confirm whether these are "net exercise" (cashless) warrants: if exercised net, the dilutive ` +
          `share count equals only the in-the-money spread, not the full face count. ` +
          `Review each warrant's exercise mechanics and strike price before finalising the FD denominator.`,
      });
    }

    // Informal / unissued equity promises
    const informalHolders = preRoundCap.filter(s => s.informal === true);
    if (informalHolders.length > 0) {
      warnings.push({ severity: 'warning', code: 'INFORMAL_EQUITY',
        message:
          `${informalHolders.length} stakeholder(s) flagged as informal/unissued: ` +
          `${informalHolders.map(s => s.name).join(', ')}. ` +
          `These represent "handshake" promises or offer letters that have not been formally executed. ` +
          `Determine whether they should be formalised and added to the cap table before closing, or ` +
          `excluded from the FD count entirely.`,
      });
    }

    // Treasury / cancelled shares
    const treasuryHolders = preRoundCap.filter(s => s.treasury === true);
    if (treasuryHolders.length > 0) {
      warnings.push({ severity: 'warning', code: 'TREASURY_SHARES',
        message:
          `${treasuryHolders.length} treasury or cancelled share block(s) detected: ` +
          `${treasuryHolders.map(s => `${s.name} (${formatNumber(s.shares || 0)} shares)`).join(', ')}. ` +
          `Repurchased and cancelled shares must be excluded from the fully-diluted denominator. ` +
          `Confirm these entries are NOT counted in the FD share total used for PPS calculation.`,
      });
    }

    // Springing / milestone-based grants
    const springingGrants = preRoundCap.filter(s => s.springing === true || s.milestone === true);
    if (springingGrants.length > 0) {
      warnings.push({ severity: 'warning', code: 'SPRINGING_GRANT',
        message:
          `${springingGrants.length} springing or milestone-based grant(s) detected: ` +
          `${springingGrants.map(s => s.name).join(', ')}. ` +
          `These shares or options vest (or spring into existence) only upon achieving a defined milestone ` +
          `(e.g. revenue target, FDA approval, Series B closing). ` +
          `If the milestone has NOT been reached at closing, exclude these from the pre-money FD count. ` +
          `If the milestone IS triggered by this financing, include them now.`,
      });
    }

    // ================================================================
    // SECTION 2 — SAFE / NOTE CONVERSION DETAILS
    // ================================================================

    // Pre-money vs post-money SAFE method
    const preMoneySAFEs  = preRoundCap.filter(s => s.type === 'safe' && s.safeType !== 'post-money');
    const postMoneySAFEs = preRoundCap.filter(s => s.type === 'safe' && s.safeType === 'post-money');

    if (preMoneySAFEs.length > 0) {
      notes.push({ code: 'SAFE_METHOD_PRE_MONEY',
        message:
          `${preMoneySAFEs.length} pre-money SAFE(s): ${preMoneySAFEs.map(s => s.name).join(', ')}. ` +
          `Pre-money SAFEs convert on the pre-money fully-diluted cap, diluting founders AND all ` +
          `existing holders before the new investor's price is set. ` +
          `Conversion price = min(valuationCap / pre-money FD, round PPS × discountRate, round PPS).`,
      });
    }

    if (postMoneySAFEs.length > 0) {
      notes.push({ code: 'SAFE_METHOD_POST_MONEY',
        message:
          `${postMoneySAFEs.length} post-money SAFE(s): ${postMoneySAFEs.map(s => s.name).join(', ')}. ` +
          `Post-money SAFEs maintain a fixed post-closing ownership percentage for the SAFE holder. ` +
          `They dilute only founders and prior holders — NOT the new lead investor. ` +
          `Carefully check pro-rata rights and MFN provisions; double-dilution errors are common here.`,
      });
    }

    // Notes missing issue date — interest cannot be accrued
    const notesNoIssueDate = preRoundCap.filter(s => s.type === 'note' && s.interestRate && !s.issueDate);
    if (notesNoIssueDate.length > 0) {
      warnings.push({ severity: 'warning', code: 'NOTE_NO_ISSUE_DATE',
        message:
          `${notesNoIssueDate.length} convertible note(s) carry an interest rate but no issue date: ` +
          `${notesNoIssueDate.map(s => s.name).join(', ')}. ` +
          `No interest is being accrued. Add an "issueDate" field to each note so accrued interest ` +
          `through the closing date is included in the conversion amount.`,
      });
    }

    // Notes with interest but no explicit closing date
    const notesWithAccrual = preRoundCap.filter(s => s.type === 'note' && s.interestRate && s.issueDate);
    if (notesWithAccrual.length > 0 && !roundConfig.closingDate) {
      warnings.push({ severity: 'warning', code: 'NOTE_CLOSING_DATE_DEFAULT',
        message:
          `${notesWithAccrual.length} convertible note(s) are accruing interest but no closingDate was ` +
          `specified in the round config. Interest is being calculated to today's date ` +
          `(${new Date().toISOString().slice(0, 10)}). ` +
          `Set a "closingDate" in the round config to lock in the exact interest amount. ` +
          `Even a few missing days of interest can change the conversion share count.`,
      });
    }

    // ================================================================
    // SECTION 3 — OPTION POOL EXPANSION
    // ================================================================

    if (optionPoolTargetPct > 0) {
      // Unallocated vs total pool
      const totalPoolShares    = postRoundCap.filter(s => s.type === 'option').reduce((sum, s) => sum + (s.shares || 0), 0);
      const allocatedShares    = postRoundCap.filter(s => s.type === 'option' && s.allocated === true).reduce((sum, s) => sum + (s.shares || 0), 0);
      const unallocatedShares  = totalPoolShares - allocatedShares;
      const unallocatedPct     = postFD > 0 ? unallocatedShares / postFD : 0;

      if (allocatedShares > 0) {
        notes.push({ code: 'OPTION_POOL_UNALLOCATED',
          message:
            `Option pool after closing: ${formatNumber(totalPoolShares)} total shares. ` +
            `Allocated (issued/outstanding options): ${formatNumber(allocatedShares)}. ` +
            `Unallocated (available for future grants): ${formatNumber(unallocatedShares)} ` +
            `(${formatPct(unallocatedPct)} of post-round FD). ` +
            `Investors typically focus on unallocated availability when assessing hiring capacity.`,
        });
      } else {
        notes.push({ code: 'OPTION_POOL_UNALLOCATED',
          message:
            `Option pool after closing: ${formatNumber(totalPoolShares)} total shares ` +
            `(${formatPct(result.actualOptionPoolPct)} of post-round FD). ` +
            `To separately track allocated vs. unallocated shares, mark issued option grants ` +
            `with "allocated": true in the stakeholder list.`,
        });
      }

      // Confirm pool percentage basis
      notes.push({ code: 'OPTION_POOL_BASIS',
        message:
          `Option pool target (${formatPct(optionPoolTargetPct)}) is measured against the ` +
          `post-money fully-diluted share count (${formatNumber(postFD)} shares). ` +
          `Method: ${optionPoolMethod}. ` +
          (optionPoolMethod === 'pre-money'
            ? `The pool was expanded before the new-money PPS was set ("option pool shuffle"), ` +
              `which lowers the effective pre-money valuation for founders.`
            : `The pool was expanded after the new-money PPS was set, diluting all post-round ` +
              `holders equally — no shuffle effect.`),
      });
    }

    // ================================================================
    // SECTION 4 — NEW MONEY MECHANICS
    // ================================================================

    // PPS decimal precision note
    if (isFinite(pps) && pps > 0) {
      const pps4dp = parseFloat(pps.toFixed(4));
      const pps5dp = parseFloat(pps.toFixed(5));
      const delta4 = Math.abs(pps - pps4dp) / pps;
      const delta5 = Math.abs(pps - pps5dp) / pps;
      notes.push({ code: 'PPS_PRECISION',
        message:
          `Price per share: ${formatCurrency(pps, 5)} (5 d.p.) / ${formatCurrency(pps, 4)} (4 d.p.). ` +
          `NVCA model documents typically round to 4–5 decimal places. ` +
          `Rounding to 4 d.p. introduces a ${formatPct(delta4)} error; ` +
          `rounding to 5 d.p. introduces a ${formatPct(delta5)} error. ` +
          `Ensure your spreadsheet uses consistent precision so the total investment ` +
          `(shares × PPS) does not diverge from the agreed amount by more than a few dollars.`,
      });
    }

    // ================================================================
    // SECTION 5 — POST-CLOSING CAPITALIZATION
    // ================================================================

    // Ownership sum must equal exactly 100%
    if (postFD > 0) {
      const ownershipSum  = postRoundCap.reduce((sum, s) => sum + (s.shares || 0), 0);
      const ownershipFrac = ownershipSum / postFD;
      const ownershipErr  = Math.abs(ownershipFrac - 1);
      if (ownershipErr > 0.0001) {
        issues.push({ severity: 'error', code: 'OWNERSHIP_SUM_ERROR',
          message:
            `Post-round cap table shares sum to ${formatNumber(ownershipSum)} but the computed ` +
            `fully-diluted count is ${formatNumber(postFD)} — ownership percentages would sum to ` +
            `${formatPct(ownershipFrac)} instead of 100.00%. ` +
            `This indicates a share-count discrepancy. Review all entries for duplicate or missing rows.`,
        });
      } else {
        notes.push({ code: 'OWNERSHIP_SUM_OK',
          message:
            `Ownership integrity check: all post-round holders sum to ` +
            `${formatPct(ownershipFrac)} ✓ (${formatNumber(ownershipSum)} / ${formatNumber(postFD)} shares).`,
        });
      }
    }

    // Liquidation waterfall summary
    const allPreferred = postRoundCap.filter(s => s.type === 'preferred');
    if (allPreferred.length > 0) {
      const totalLiqPref       = allPreferred.reduce((sum, s) => {
        const oip    = s.originalIssuePrice || 0;
        const mult   = s.liquidationMultiple || 1;
        const shares = s.shares || 0;
        return sum + oip * mult * shares;
      }, 0);
      const participatingCount = allPreferred.filter(s => s.participating).length;
      const cappedCount        = allPreferred.filter(s => s.participating && s.participationCap).length;
      notes.push({ code: 'WATERFALL_SUMMARY',
        message:
          `Liquidation preference waterfall: aggregate preference stack = ${formatCurrency(totalLiqPref)}. ` +
          `${allPreferred.length} preferred series; ` +
          `${participatingCount} participating` +
          (cappedCount ? ` (${cappedCount} capped)` : '') +
          `, ${allPreferred.length - participatingCount} non-participating (straight preferred). ` +
          `NVCA standard is 1× non-participating. ` +
          `Model the waterfall at representative exit values (1×, 2×, and 5× invested capital) ` +
          `to confirm the preference stack behaves as expected under the NVCA Charter.`,
      });
    }

    // Anti-dilution baseline — record OIP for the new series
    if (roundConfig.newShareClass) {
      notes.push({ code: 'ANTI_DILUTION_BASELINE',
        message:
          `Anti-dilution baseline: Original Issue Price (OIP) for ${roundConfig.newShareClass} = ` +
          `${formatCurrency(pps, 5)}. ` +
          `This is the reference price for future broad-based weighted-average (BBWA) anti-dilution ` +
          `adjustments. If a subsequent round prices below this OIP, the conversion ratio for ` +
          `${roundConfig.newShareClass} will be adjusted upward in favour of existing holders.`,
      });
    }

    // Authorized shares check
    if (roundConfig.authorizedShares) {
      const authorized  = roundConfig.authorizedShares;
      const utilization = authorized > 0 ? postFD / authorized : Infinity;
      if (postFD > authorized) {
        issues.push({ severity: 'error', code: 'AUTHORIZED_SHARES_EXCEEDED',
          message:
            `Post-round fully-diluted share count (${formatNumber(postFD)}) exceeds the authorized ` +
            `share count (${formatNumber(authorized)}). ` +
            `The company's Certificate of Incorporation / Charter must be amended to authorize ` +
            `sufficient shares (including enough Common to cover full preferred conversion) ` +
            `before the round can close.`,
        });
      } else if (utilization > 0.8) {
        warnings.push({ severity: 'warning', code: 'AUTHORIZED_SHARES_WARNING',
          message:
            `Post-round FD (${formatNumber(postFD)}) consumes ${formatPct(utilization)} of authorized ` +
            `shares (${formatNumber(authorized)}). Less than 20% headroom remains. ` +
            `Consider amending the Charter to authorize additional shares before the next financing ` +
            `to avoid a last-minute amendment at a future closing.`,
        });
      }
    }

    return {
      issues,
      warnings,
      notes,
      summary: {
        issueCount:   issues.length,
        warningCount: warnings.length,
        noteCount:    notes.length,
        hasErrors:    issues.length > 0,
        status:       issues.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok',
      },
    };
  }

  // ============================================================
  // SCENARIO TEMPLATES
  // ============================================================

  /**
   * Return a named template { name, stakeholders, roundConfig }.
   * @param {'seed-round'|'series-a'|'safe-conversion'|'down-round'} scenario
   */
  function buildTemplate(scenario) {
    const templates = {
      'seed-round': {
        name: 'Seed Round',
        description: 'Typical seed round: two founders, small option pool, new seed preferred.',
        stakeholders: [
          { name: 'Founder 1', type: 'common', shares: 3_000_000 },
          { name: 'Founder 2', type: 'common', shares: 3_000_000 },
          { name: 'Advisor Grants', type: 'option', shares: 200_000 },
          { name: 'Option Pool', type: 'option', shares: 300_000 },
        ],
        roundConfig: {
          roundName:           'Seed',
          preMoneyValuation:   5_000_000,
          newInvestment:       1_000_000,
          optionPoolTargetPct: 0.15,
          optionPoolMethod:    'pre-money',
          newShareClass:       'Seed Preferred',
          newInvestorName:     'Seed Investors',
          liquidationMultiple: 1,
          participating:       false,
          closingDate:         '2024-03-01',
        },
      },

      'series-a': {
        name: 'Series A with SAFE',
        description: 'Series A round with existing seed round and a pre-money SAFE converting in.',
        stakeholders: [
          { name: 'Founder 1', type: 'common', shares: 3_000_000 },
          { name: 'Founder 2', type: 'common', shares: 2_500_000 },
          { name: 'Seed Investors', type: 'preferred', shares: 1_200_000, series: 'Seed', originalIssuePrice: 0.8333, liquidationMultiple: 1, participating: false },
          { name: 'Option Pool', type: 'option', shares: 1_300_000 },
          { name: 'Angel SAFE', type: 'safe', shares: 0, principal: 500_000, valuationCap: 8_000_000, discountRate: 0.8, safeType: 'pre-money' },
        ],
        roundConfig: {
          roundName:           'Series A',
          preMoneyValuation:   12_000_000,
          newInvestment:       3_000_000,
          optionPoolTargetPct: 0.15,
          optionPoolMethod:    'pre-money',
          newShareClass:       'Series A Preferred',
          newInvestorName:     'Series A Lead',
          liquidationMultiple: 1,
          participating:       false,
          closingDate:         '2024-06-01',
        },
      },

      'safe-conversion': {
        name: 'Multiple SAFE & Note Conversions',
        description: 'Series A with four converting instruments: cap-only SAFE, discount-only SAFE, cap+discount SAFE, and a convertible note.',
        stakeholders: [
          { name: 'Founders', type: 'common', shares: 8_000_000 },
          { name: 'Option Pool', type: 'option', shares: 2_000_000 },
          { name: 'SAFE – Cap Only',         type: 'safe', shares: 0, principal: 250_000, valuationCap: 5_000_000, discountRate: null,  safeType: 'pre-money' },
          { name: 'SAFE – Discount Only',    type: 'safe', shares: 0, principal: 250_000, valuationCap: null,      discountRate: 0.8,   safeType: 'pre-money' },
          { name: 'SAFE – Cap & Discount',   type: 'safe', shares: 0, principal: 500_000, valuationCap: 7_000_000, discountRate: 0.85,  safeType: 'pre-money' },
          { name: 'Convertible Note',        type: 'note', shares: 0, principal: 1_000_000, interestRate: 0.06, issueDate: '2023-01-01', valuationCap: 8_000_000, discountRate: 0.8 },
        ],
        roundConfig: {
          roundName:           'Series A',
          preMoneyValuation:   15_000_000,
          newInvestment:       5_000_000,
          optionPoolTargetPct: 0.15,
          optionPoolMethod:    'pre-money',
          newShareClass:       'Series A Preferred',
          newInvestorName:     'Lead VC',
          liquidationMultiple: 1,
          participating:       false,
          closingDate:         '2024-06-01',
        },
      },

      'down-round': {
        name: 'Down Round',
        description: 'Series B at a lower valuation than Series A — triggers anti-dilution analysis.',
        stakeholders: [
          { name: 'Founders', type: 'common', shares: 5_000_000 },
          { name: 'Seed Preferred', type: 'preferred', shares: 800_000, series: 'Seed', originalIssuePrice: 0.625, liquidationMultiple: 1, participating: false },
          { name: 'Series A Preferred', type: 'preferred', shares: 2_000_000, series: 'A', originalIssuePrice: 2.50, liquidationMultiple: 1, participating: false },
          { name: 'Option Pool', type: 'option', shares: 1_200_000 },
        ],
        roundConfig: {
          roundName:           'Series B (Down)',
          preMoneyValuation:   10_000_000,  // Series A was at $15M post
          newInvestment:       3_000_000,
          optionPoolTargetPct: 0.10,
          optionPoolMethod:    'pre-money',
          newShareClass:       'Series B Preferred',
          newInvestorName:     'Series B Investors',
          liquidationMultiple: 1,
          participating:       false,
          closingDate:         '2025-01-01',
        },
      },
    };

    return templates[scenario] || null;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    // Core pipeline
    buildProForma,
    analyzeProForma,
    buildTemplate,

    // Individual calculators (useful for testing)
    calculatePreMoneyOptionPoolExpansion,
    convertSAFE,
    convertNote,
    accruedInterest,
    daysBetween,
    roundShares,
    getFullyDiluted,
    getOptionPool,

    // Formatters
    formatCurrency,
    formatNumber,
    formatPct,
  };
})();

// CommonJS export — lets Node.js load this file directly via require()
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProFormaEngine;
}
