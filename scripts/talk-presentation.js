'use strict';
/* Talk answer presentation — Atlas-owned wording for verified packet claims.
 *
 * Slice 4 sits after Slice 3 verification. Gemini still returns only
 * extractive path/equals claims. The server still rejects any claim that
 * does not match this request's packet. This module then maps those
 * already-verified claims through deterministic templates. Slice 6B
 * also maps an already-computed Forecast hypothetical result into
 * wording. Why-explanations map already-published packet fields and
 * last-presented Talk result identifiers through provenance templates;
 * they do not invent causes. A Why? of a prior hypothetical or
 * comparison reprints that already-published Forecast as-of /
 * freshness; it does not attach a later packet as-of to an unrecomputed
 * result. This file still does not call Forecast,
 * does not compute leftover or remaining, and does not invent a second
 * financial schema. Remaining payday bills reprint Forecast-owned
 * currentPeriodAction.bills; Talk does not date-filter that list, sum
 * remaining amounts, invent a paid list, or treat unverified as unpaid.
 * Optional presentation.cards reprint those same trusted strings for
 * the Talk card surface. Cards do not add numbers. Household-facing
 * citations are assembled here from the same source / trust / as-of /
 * action fields. Gemini does not invent them.
 * Optional presentation.summary is a five-section household decision
 * briefing assembled from those already-verified presentation fields,
 * card bodies, and citation labels. It does not calculate, rank, or
 * convert uncertainty into a recommendation. Assembly failure leaves
 * the incumbent answer, cards, and citations in place.
 *
 * Unknown paths stay conservative: path-is-value wording, no human
 * meaning, no Forecast/Bills/Credit/Planning provenance, no nav action.
 * Null on a known money path is unavailable, never $0.
 * Trust tags are copied from the packet; estimated is never confirmed,
 * stale is never current, dated-opening spendable cash is never current
 * spendable cash, unavailable is never a number.
 */

const UNAVAILABLE_ANSWER = 'That is not available in this request\'s packet.';
const REMAINING_BILLS_UNAVAILABLE_ANSWER = 'Remaining payday bills are unavailable.';
const REMAINING_BILLS_EMPTY_ANSWER = 'Forecast lists no remaining payday bills before the next payday.';
const REMAINING_BILLS_COVERED_LEAD = 'Forecast lists these bills as represented on this payday period.';
const REMAINING_BILLS_COVERED_EMPTY = 'Forecast lists no represented bills on this payday period.';
const REMAINING_BILLS_UNVERIFIED_NOTE = 'Forecast has not verified that it posted. That is not unpaid, late, overdue, or definitely due.';
const REMAINING_BILLS_LEAD = 'Forecast still lists these bills before the next payday.';
const HYPOTHETICAL_UNAVAILABLE_ANSWER = 'That hypothetical extra payment is not available from Forecast';
const HYPOTHETICAL_COMPARISON_UNAVAILABLE_ANSWER = 'That hypothetical comparison is not available from Forecast';
const WHY_UNAVAILABLE_ANSWER = 'That explanation is not available from this request\'s packet.';
const WHY_LEAD = 'Atlas is showing that from already-published household fields, not a new calculation.';
const WHY_NOTE = 'This is an explanation of an already-published Atlas result. It is not a recommendation, a new Forecast calculation, or permission to act.';
const WHY_HISTORY_NOTE = 'Conversation history is not household-financial evidence. This request\'s packet is.';
const WHY_BASELINE_NOTE = 'Conversation history is not household-financial evidence. This explanation uses the already-published Forecast baseline, not a later packet as-of.';

const ALLOWED_ACTIONS = Object.freeze({
  budget: Object.freeze({ href: '/', label: 'View Budget' }),
  bills: Object.freeze({ href: '/bills.html', label: 'View Bills' }),
  credit: Object.freeze({ href: '/credit.html', label: 'View Credit' }),
  planning: Object.freeze({ href: '/planning.html', label: 'View Planning' }),
});

const ALLOWED_ACTION_HREFS = Object.freeze(['/', '/bills.html', '/credit.html', '/planning.html']);
const ALLOWED_SOURCES = Object.freeze(['Forecast', 'Bills', 'Credit', 'Planning']);
const SURFACE_LABELS = Object.freeze({
  '/': 'Budget',
  '/bills.html': 'Bills',
  '/credit.html': 'Credit',
  '/planning.html': 'Planning',
});
const CITATION_KINDS = Object.freeze({
  surface: true,
  provenance: true,
});
const CITATION_TRUST = Object.freeze({
  unavailable: true,
  unknown: true,
  'dated-opening': true,
  planned: true,
  estimated: true,
  'posted-only': true,
  calculated: true,
  'owner-stated': true,
  'canonical-opening': true,
  precise: true,
  confirmed: true,
  live: true,
});
const CARD_VERSION = 1;
const CARD_KINDS = Object.freeze({
  answer: true,
  option: true,
  result: true,
  judgment: true,
  provenance: true,
  action: true,
  note: true,
});
const SUMMARY_VERSION = 1;
const SUMMARY_SECTION_ORDER = Object.freeze([
  'knows',
  'changes',
  'unchanged',
  'risk',
  'unknown',
]);
const SUMMARY_TITLES = Object.freeze({
  knows: 'What Atlas knows',
  changes: 'What changes',
  unchanged: 'What does not change',
  risk: 'Risk / uncertainty',
  unknown: 'What Atlas cannot determine yet',
});
const SUMMARY_CLOSED = Object.freeze({
  noForecastChange: 'This answer does not compute a Forecast change.',
  reprintsOnly: 'This reprints already-published Atlas fields. It does not change household balances.',
  reprintsForecastChange: 'This reprints already-published Forecast change fields.',
  packetOnly: 'Atlas cannot determine facts that are not in this request\'s packet.',
  unavailableNotNumber: 'Unavailable is not a number.',
  unknownNotFigure: 'Unknown is not a published figure.',
  estimatedNotConfirmed: 'Estimated is not confirmed.',
  staleNotCurrent: 'Stale is not current.',
  datedOpeningNotCurrent: 'A dated opening is not current spendable household cash.',
  freshnessUnavailable: 'Packet freshness is unavailable.',
});

function isPrimitive(value) {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function formatClaimValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatCurrency(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  const abs = Math.abs(n).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (n < 0 ? '−$' : '$') + abs;
}

function packetGet(packet, path) {
  if (!packet || typeof packet !== 'object' || typeof path !== 'string') return undefined;
  const parts = path.split('.');
  let current = packet;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function remainingClaimTrust(packet) {
  const claim = packetGet(packet, 'forecast.currentPeriodAction.remainingClaim');
  if (claim === 'precise' || claim === 'posted-only' || claim === 'unavailable') return claim;
  return null;
}

function leftoverTrust(packet) {
  const status = packetGet(packet, 'forecast.predictedEndingBalance.status');
  if (status === 'unavailable') return 'unavailable';
  const value = packetGet(packet, 'forecast.predictedEndingBalance.amount');
  if (value == null || !Number.isFinite(Number(value))) return 'unavailable';
  return 'calculated';
}

function paydayAllocationMoneyTrust(packet, path) {
  const status = packetGet(packet, 'forecast.paydayAllocation.status');
  if (status === 'unavailable') return 'unavailable';
  const value = packetGet(packet, path);
  if (value == null || !Number.isFinite(Number(value))) return 'unavailable';
  return 'calculated';
}

function facilityFromAvailablePath(path, packet) {
  const match = /^current\.debts\.facilities\[(\d{1,3})\]\.available$/.exec(path);
  if (!match) return null;
  const facilities = packetGet(packet, 'current.debts.facilities');
  if (!Array.isArray(facilities)) return null;
  const facility = facilities[Number(match[1])];
  if (!facility || typeof facility !== 'object' || Array.isArray(facility)) return null;
  return facility;
}

function facilityAvailableUnpublished(facility) {
  return !!(facility && (facility.pendingUnknown === true || facility.trust === 'unknown'));
}

function spendableOpeningState(packet) {
  return {
    status: packetGet(packet, 'current.spendableHouseholdCash.status'),
    current: packetGet(packet, 'current.spendableHouseholdCash.current'),
  };
}

function spendableIsNonCurrentOpening(packet) {
  const opening = spendableOpeningState(packet);
  return opening.status === 'dated-opening' || opening.current === false;
}

function spendableTrust(packet) {
  if (spendableIsNonCurrentOpening(packet)) {
    const status = spendableOpeningState(packet).status;
    return status === 'dated-opening' ? 'dated-opening' : 'unavailable';
  }
  const trust = packetGet(packet, 'current.spendableHouseholdCash.trust');
  return typeof trust === 'string' && trust ? trust : null;
}

function presentSpendableHouseholdCash(value, packet) {
  if (spendableIsNonCurrentOpening(packet)) {
    const formatted = formatCurrency(value);
    if (!formatted) {
      return {
        text: 'Spendable household cash is unavailable. This is a dated, non-current opening.',
        trust: 'unavailable',
      };
    }
    return {
      text: `Dated opening cash is ${formatted}. This is not current spendable household cash.`,
      trust: 'dated-opening',
    };
  }
  return moneySentence({
    available: money => `Spendable household cash is ${money}.`,
    unavailable: 'Spendable household cash is unavailable.',
  }, value);
}

function obligationConfidence(packet, field) {
  const tag = packetGet(packet, `current.nextSignificantObligations.${field}.confidence`);
  if (tag === 'confirmed' || tag === 'estimated' || tag === 'planned' || tag === 'unknown') {
    return tag;
  }
  return null;
}

function moneySentence(template, value) {
  const formatted = formatCurrency(value);
  if (!formatted) {
    return { text: template.unavailable, trust: 'unavailable' };
  }
  return { text: template.available(formatted) };
}

function closedPolicySentence(value, allowed, sentence) {
  if (value !== allowed) {
    return { text: 'That owner policy label is unavailable.', trust: 'unavailable' };
  }
  return { text: sentence, trust: 'owner-stated' };
}

const PATH_RULES = [
  {
    path: 'forecast.currentPeriodAction.essentialRemaining',
    source: 'Forecast',
    action: 'budget',
    trust: remainingClaimTrust,
    present(value) {
      return moneySentence({
        available: money => `You have ${money} remaining in the current pay period.`,
        unavailable: 'Current pay-period remaining is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.runningLeftover.currentBalance',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.runningLeftover.currentBalance'
    ),
    present(value) {
      return moneySentence({
        available: money => `This payday has ${money}.`,
        unavailable: 'What this payday has is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.obligations.allocated',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.obligations.allocated'
    ),
    present(value) {
      return moneySentence({
        available: money => `Forecast set aside ${money} for bills.`,
        unavailable: 'The bills set-aside is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.runningLeftover.afterBills',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.runningLeftover.afterBills'
    ),
    present(value) {
      return moneySentence({
        available: money => `After bills, ${money} remains.`,
        unavailable: 'The amount remaining after bills is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.essentials.allocated',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.essentials.allocated'
    ),
    present(value) {
      return moneySentence({
        available: money => `Forecast is holding ${money} for household costs.`,
        unavailable: 'The household-cost hold is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.runningLeftover.afterHouseholdBudget',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.runningLeftover.afterHouseholdBudget'
    ),
    present(value) {
      return moneySentence({
        available: money => `After household costs, ${money} remains.`,
        unavailable: 'The amount remaining after household costs is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.extraDebt.allocated',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.extraDebt.allocated'
    ),
    present(value) {
      return moneySentence({
        available: money => `Forecast allocated ${money} to extra debt.`,
        unavailable: 'The extra-debt allocation is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.runningLeftover.afterDebtRepayment',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.runningLeftover.afterDebtRepayment'
    ),
    present(value) {
      return moneySentence({
        available: money => `After extra debt, ${money} remains.`,
        unavailable: 'The amount remaining after extra debt is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.predictedEndingBalance.amount',
    source: 'Forecast',
    action: 'budget',
    trust: leftoverTrust,
    present(value) {
      return moneySentence({
        available: money => `Balance after deductions for this pay period is ${money}.`,
        unavailable: 'Balance after deductions is unavailable.',

      }, value);
    },
  },
  {
    path: 'forecast.paydayAllocation.runningLeftover.afterBigPurchases',
    source: 'Forecast',
    action: 'budget',
    trust: packet => paydayAllocationMoneyTrust(
      packet,
      'forecast.paydayAllocation.runningLeftover.afterBigPurchases'
    ),
    present(value) {
      return moneySentence({
        available: money => `This payday leaves us with ${money}.`,
        unavailable: 'Payday leftover is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.currentPeriodAction.weeklyCap',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      return moneySentence({
        available: money => `The current weekly spending cap is ${money}.`,
        unavailable: 'The current weekly spending cap is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.recommendation.weekly',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      return moneySentence({
        available: money => `The Forecast weekly amount is ${money}.`,
        unavailable: 'The Forecast weekly amount is unavailable.',
      }, value);
    },
  },
  {
    path: 'forecast.budgetCap.weekly',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      return moneySentence({
        available: money => `The budget weekly cap is ${money}.`,
        unavailable: 'The budget weekly cap is unavailable.',
      }, value);
    },
  },
  {
    path: 'current.spendableHouseholdCash.value',
    source: 'Forecast',
    action: 'budget',
    trust: spendableTrust,
    present: presentSpendableHouseholdCash,
  },
  {
    path: 'current.pending.totalKnownPending',
    source: 'Credit',
    action: 'credit',
    present(value) {
      return moneySentence({
        available: money => `Known pending charges total ${money}.`,
        unavailable: 'Known pending charges are unavailable.',
      }, value);
    },
  },
  {
    path: 'current.debts.totalAvailableCredit',
    source: 'Credit',
    action: 'credit',
    present(value) {
      return moneySentence({
        available: money => `Total available credit is ${money}.`,
        unavailable: 'Total available credit is unavailable.',
      }, value);
    },
  },
  {
    path: 'current.debts.overLimitCount',
    source: 'Credit',
    action: 'credit',
    present(value) {
      if (!Number.isFinite(Number(value))) {
        return { text: 'Over-limit credit facilities are unavailable.', trust: 'unavailable' };
      }
      const count = Number(value);
      if (count === 0) return { text: 'No credit facilities are over the limit.' };
      if (count === 1) return { text: '1 credit facility is over the limit.' };
      return { text: `${count} credit facilities are over the limit.` };
    },
  },
  {
    path: 'current.debts.securedDebt',
    source: 'Credit',
    action: 'credit',
    present(value) {
      return moneySentence({
        available: money => `Secured debt totals ${money}.`,
        unavailable: 'Secured debt is unavailable.',
      }, value);
    },
  },
  {
    path: 'current.debts.monthlyInterest',
    source: 'Credit',
    action: 'credit',
    present(value) {
      return moneySentence({
        available: money => `Monthly interest is ${money}.`,
        unavailable: 'Monthly interest is unavailable.',
      }, value);
    },
  },
  {
    path: 'current.nextSignificantObligations.nextDue.amount',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextDue'),
    present(value) {
      return moneySentence({
        available: money => `The next due amount is ${money}.`,
        unavailable: 'The next due amount is unavailable.',
      }, value);
    },
  },
  {
    path: 'current.nextSignificantObligations.nextDue.label',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextDue'),
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The next due label is unavailable.', trust: 'unavailable' };
      }
      return { text: `The next due item is ${value}.` };
    },
  },
  {
    path: 'current.nextSignificantObligations.nextDue.date',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextDue'),
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The next due date is unavailable.', trust: 'unavailable' };
      }
      return { text: `The next due date is ${value}.` };
    },
  },
  {
    path: 'current.nextSignificantObligations.nextDue.daysUntil',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextDue'),
    present(value) {
      if (!Number.isFinite(Number(value))) {
        return { text: 'The next due timing is unavailable.', trust: 'unavailable' };
      }
      const days = Number(value);
      if (days === 0) return { text: 'The next due item is due today.' };
      if (days === 1) return { text: 'The next due item is in 1 day.' };
      return { text: `The next due item is in ${days} days.` };
    },
  },
  {
    path: 'current.nextSignificantObligations.nextPaymentOut.amount',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextPaymentOut'),
    present(value) {
      return moneySentence({
        available: money => `The next payment out is ${money}.`,
        unavailable: 'The next payment out is unavailable.',
      }, value);
    },
  },
  {
    path: 'current.nextSignificantObligations.nextPaymentOut.label',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextPaymentOut'),
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The next payment-out label is unavailable.', trust: 'unavailable' };
      }
      return { text: `The next payment out is ${value}.` };
    },
  },
  {
    path: 'current.nextSignificantObligations.nextPaymentOut.date',
    source: 'Bills',
    action: 'bills',
    trust: packet => obligationConfidence(packet, 'nextPaymentOut'),
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The next payment-out date is unavailable.', trust: 'unavailable' };
      }
      return { text: `The next payment out is on ${value}.` };
    },
  },
  {
    path: 'forecast.currentPeriodAction.remainingClaim',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      if (value === 'precise' || value === 'posted-only' || value === 'unavailable') {
        return { text: `Current-period remaining is marked ${value}.`, trust: value };
      }
      return { text: 'Current-period remaining status is unavailable.', trust: 'unavailable' };
    },
  },
  {
    path: 'forecast.currentPeriodAction.periodStart',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The current pay-period start is unavailable.', trust: 'unavailable' };
      }
      return { text: `The current pay period starts on ${value}.` };
    },
  },
  {
    path: 'forecast.currentPeriodAction.periodEnd',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The current pay-period end is unavailable.', trust: 'unavailable' };
      }
      return { text: `The current pay period ends on ${value}.` };
    },
  },
  {
    path: 'forecast.currentPeriodAction.nextPayday',
    source: 'Forecast',
    action: 'budget',
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The next payday is unavailable.', trust: 'unavailable' };
      }
      return { text: `The next payday is ${value}.` };
    },
  },
  {
    path: 'metadata.effectiveAsOf',
    source: null,
    action: null,
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'The packet as-of date is unavailable.', trust: 'unavailable' };
      }
      return { text: `This picture is as of ${value}.` };
    },
  },
  {
    path: 'metadata.freshness.confidence',
    source: null,
    action: null,
    present(value) {
      if (typeof value !== 'string' || !value) {
        return { text: 'Packet freshness is unavailable.', trust: 'unavailable' };
      }
      return { text: `Packet freshness is ${value}.`, trust: value };
    },
  },
  {
    path: 'policy.decisionPosture.posture',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'aggressive-not-brittle',
        'The household decision posture is aggressive, but not brittle.');
    },
  },
  {
    path: 'policy.decisionPosture.velocity',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'fastest-to-goal',
        'Velocity means getting to the financial goal as fast as possible.');
    },
  },
  {
    path: 'policy.decisionPosture.resilience',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'enough-cash-flexibility-for-real-life-and-known-commitments',
        'Resilience means enough cash and flexibility for real life and known commitments.');
    },
  },
  {
    path: 'policy.decisionPosture.breathingRoom',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'sustainable-slack-not-waste-permission',
        'Breathing room is enough slack to stay sustainable and reduce immediate re-borrow risk. It is not waste permission, comfort-max, avoiding hard choices, or slowing without a demonstrated resilience reason.');
    },
  },
  {
    path: 'policy.decisionPosture.knownCommitments',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'exert-gravity',
        'Known authorized future commitments exert gravity on household decisions.');
    },
  },
  {
    path: 'policy.decisionPosture.cheapestWhenBrittle',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'not-best-household-decision',
        'Mathematically cheapest is not the best household decision when that cheapest path is unacceptably brittle.');
    },
  },
  {
    path: 'policy.decisionPosture.numericThreshold',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'none',
        'There is no universal numeric breathing-room threshold.');
    },
  },
  {
    path: 'policy.decisionPosture.forecastApplication',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'not-applied-this-slice',
        'Forecast does not apply this decision-posture row in this slice.');
    },
  },
  {
    path: 'policy.decisionPosture.provenance',
    source: null,
    action: null,
    present(value) {
      return closedPolicySentence(value, 'owner-stated',
        'This decision posture is owner-stated.');
    },
  },
  {
    path: 'policy.decisionPosture.provenanceDate',
    source: null,
    action: null,
    present(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { text: 'The decision-posture authorization date is unavailable.', trust: 'unavailable' };
      }
      return {
        text: `The owner authorized this decision posture on ${value}.`,
        trust: 'owner-stated',
      };
    },
  },
];

const PATH_RULE_INDEX = new Map(PATH_RULES.map(rule => [rule.path, rule]));

const CATEGORY_REMAINING_RE = /^actuals\.currentPeriodCategories\[\d{1,3}\]\.remaining$/;
const COMMITMENT_REMAINING_RE = /^forecast\.upcomingModeledCommitments\.items\[\d{1,3}\]\.remaining$/;
const FACILITY_AVAILABLE_RE = /^current\.debts\.facilities\[\d{1,3}\]\.available$/;
const FACILITY_LABEL_RE = /^current\.debts\.facilities\[\d{1,3}\]\.label$/;

function genericRuleFor(path) {
  if (CATEGORY_REMAINING_RE.test(path)) {
    return {
      source: 'Forecast',
      action: 'budget',
      trust: remainingClaimTrust,
      present(value) {
        return moneySentence({
          available: money => `A current-period category remaining is ${money}.`,
          unavailable: 'A current-period category remaining is unavailable.',
        }, value);
      },
    };
  }
  if (COMMITMENT_REMAINING_RE.test(path)) {
    return {
      source: 'Planning',
      action: 'planning',
      present(value) {
        return moneySentence({
          available: money => `A modeled commitment remaining is ${money}.`,
          unavailable: 'A modeled commitment remaining is unavailable.',
        }, value);
      },
    };
  }
  if (FACILITY_AVAILABLE_RE.test(path)) {
    return {
      source: 'Credit',
      action: 'credit',
      present(value, packet) {
        if (facilityAvailableUnpublished(facilityFromAvailablePath(path, packet))) {
          return {
            text: 'A credit facility available amount is unavailable.',
            trust: 'unknown',
          };
        }
        return moneySentence({
          available: money => `A credit facility has ${money} available.`,
          unavailable: 'A credit facility available amount is unavailable.',
        }, value);
      },
    };
  }
  if (FACILITY_LABEL_RE.test(path)) {
    return {
      source: 'Credit',
      action: 'credit',
      present(value) {
        if (typeof value !== 'string' || !value) {
          return { text: 'A credit facility label is unavailable.', trust: 'unavailable' };
        }
        return { text: `A credit facility is ${value}.` };
      },
    };
  }
  return null;
}

function ruleFor(path) {
  return PATH_RULE_INDEX.get(path) || genericRuleFor(path);
}

function genericSentence(claim) {
  return `This request's packet shows ${claim.path} is ${formatClaimValue(claim.value)}.`;
}

function assembleGenericAnswer(claims) {
  const parts = claims.map(claim => `${claim.path} is ${formatClaimValue(claim.value)}`);
  if (parts.length === 1) return `This request's packet shows ${parts[0]}.`;
  const last = parts.pop();
  return `This request's packet shows ${parts.join(', ')} and ${last}.`;
}

function presentClaim(claim, packet) {
  const rule = ruleFor(claim.path);
  if (!rule) {
    return {
      text: genericSentence(claim),
      source: null,
      trust: null,
      action: null,
      mapped: false,
    };
  }
  const presented = rule.present(claim.value, packet) || {};
  const trustFromRule = typeof rule.trust === 'function' ? rule.trust(packet) : null;
  const trust = presented.trust || trustFromRule || null;
  const action = rule.action && ALLOWED_ACTIONS[rule.action] ? ALLOWED_ACTIONS[rule.action] : null;
  const source = ALLOWED_SOURCES.includes(rule.source) ? rule.source : null;
  return {
    text: presented.text || genericSentence(claim),
    source,
    trust,
    action,
    mapped: true,
  };
}

function sharedValue(values) {
  const list = values.filter(value => value != null);
  if (!list.length) return null;
  const first = list[0];
  return list.every(value => {
    if (first && typeof first === 'object') {
      return value && value.href === first.href && value.label === first.label;
    }
    return value === first;
  }) ? first : null;
}

function weakestTrust(tags) {
  const rank = {
    unavailable: 0,
    unknown: 1,
    'dated-opening': 1,
    planned: 2,
    estimated: 3,
    'posted-only': 3,
    calculated: 4,
    'owner-stated': 4,
    'canonical-opening': 4,
    precise: 5,
    confirmed: 5,
    live: 5,
  };
  let weakest = null;
  let weakestRank = Infinity;
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag) continue;
    const score = Object.prototype.hasOwnProperty.call(rank, tag) ? rank[tag] : 1;
    if (score < weakestRank) {
      weakest = tag;
      weakestRank = score;
    }
  }
  return weakest;
}

function readAsOf(packet) {
  const effective = packetGet(packet, 'metadata.effectiveAsOf');
  if (typeof effective === 'string' && effective) return effective;
  const canonical = packetGet(packet, 'metadata.canonicalAsOf');
  return typeof canonical === 'string' && canonical ? canonical : null;
}

function readFreshness(packet) {
  const confidence = packetGet(packet, 'metadata.freshness.confidence');
  return typeof confidence === 'string' && confidence ? confidence : null;
}

function publicAction(action) {
  if (!action || typeof action !== 'object') return null;
  if (!ALLOWED_ACTION_HREFS.includes(action.href)) return null;
  if (typeof action.label !== 'string' || !action.label) return null;
  return { href: action.href, label: action.label };
}

function provenanceText(fields) {
  const parts = [];
  if (ALLOWED_SOURCES.includes(fields.source)) parts.push(fields.source);
  if (typeof fields.asOf === 'string' && fields.asOf) {
    parts.push('as of ' + fields.asOf);
  }
  if (typeof fields.trust === 'string' && fields.trust) {
    parts.push(fields.trust);
  }
  if (typeof fields.freshness === 'string' && fields.freshness
      && fields.freshness !== fields.trust) {
    parts.push(fields.freshness);
  }
  return parts.length ? parts.join(' · ') : null;
}

function publicCitationTrust(trust) {
  if (typeof trust !== 'string' || !trust) return null;
  if (trust === 'verified' || trust === 'current') return null;
  return CITATION_TRUST[trust] ? trust : null;
}

function publicAsOf(value) {
  if (typeof value !== 'string' || !value || value.length > 40) return null;
  if (/[\\/]/.test(value) || /\.env\b|raw|derived|secret/i.test(value)) return null;
  return value;
}

function looksLikePrivateCitation(raw) {
  if (!raw || typeof raw !== 'object') return true;
  const blob = [raw.href, raw.label, raw.source, raw.asOf, raw.file, raw.url, raw.path]
    .filter(value => typeof value === 'string')
    .join('\n');
  return /(?:^|[\\/])(?:raw|derived)[\\/]|\.env\b|scripts[\\/]|public[\\/]forecast\.js|account[_\s-]?number|ATLAS_TALK|SESSION_SECRET|SITE_PASSWORD/i.test(blob);
}

function sanitizeCitations(citations) {
  if (!Array.isArray(citations) || !citations.length) return null;
  const items = [];
  for (const raw of citations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!CITATION_KINDS[raw.kind]) return null;
    if (raw.trust === 'verified' || raw.source === 'verified') return null;
    if (looksLikePrivateCitation(raw)) return null;
    if (raw.kind === 'surface') {
      const action = publicAction({ href: raw.href, label: raw.label });
      const source = ALLOWED_SOURCES.includes(raw.source) ? raw.source : null;
      const label = action ? SURFACE_LABELS[action.href] : null;
      if (!action || !source || !label || raw.label !== label) return null;
      items.push({
        kind: 'surface',
        source,
        href: action.href,
        label,
      });
      continue;
    }
    const source = ALLOWED_SOURCES.includes(raw.source) ? raw.source : null;
    const trust = publicCitationTrust(raw.trust);
    const asOf = publicAsOf(raw.asOf);
    const freshnessRaw = publicCitationTrust(raw.freshness);
    const freshness = freshnessRaw && freshnessRaw !== trust ? freshnessRaw : null;
    if (raw.trust != null && raw.trust !== '' && !trust) return null;
    if (raw.source != null && raw.source !== '' && !source) return null;
    if (raw.asOf != null && raw.asOf !== '' && !asOf) return null;
    const label = provenanceText({ source, asOf, trust, freshness });
    if (!label || (typeof raw.label === 'string' && raw.label && raw.label !== label)) {
      return null;
    }
    items.push({
      kind: 'provenance',
      source,
      asOf,
      trust,
      freshness,
      label,
    });
  }
  return items.length ? items : null;
}

function assembleCitations(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const source = ALLOWED_SOURCES.includes(fields.source) ? fields.source : null;
  const action = publicAction(fields.action);
  const trust = publicCitationTrust(fields.trust);
  const asOf = publicAsOf(fields.asOf);
  const freshnessRaw = publicCitationTrust(fields.freshness);
  const freshness = freshnessRaw && freshnessRaw !== trust ? freshnessRaw : null;
  const items = [];
  if (source && action) {
    const label = SURFACE_LABELS[action.href];
    if (label) {
      items.push({
        kind: 'surface',
        source,
        href: action.href,
        label,
      });
    }
  }
  if (!source && trust === 'unavailable') {
    return sanitizeCitations(items);
  }
  const label = provenanceText({ source, asOf, trust, freshness });
  if (label) {
    items.push({
      kind: 'provenance',
      source,
      asOf,
      trust,
      freshness,
      label,
    });
  }
  return sanitizeCitations(items);
}

function assembleClaimCitations(rows, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  if (!Array.isArray(rows) || !rows.length) return assembleCitations(fields);
  if (rows.some(row => !row || !row.mapped)) return assembleCitations(fields);

  const items = [];
  const seenSurface = Object.create(null);
  const groups = [];
  const groupIndex = Object.create(null);
  for (const row of rows) {
    const source = ALLOWED_SOURCES.includes(row.source) ? row.source : null;
    if (!source) continue;
    const action = publicAction(row.action);
    if (action) {
      const surfaceKey = source + '\0' + action.href;
      if (!seenSurface[surfaceKey]) {
        const label = SURFACE_LABELS[action.href];
        if (label) {
          seenSurface[surfaceKey] = true;
          items.push({
            kind: 'surface',
            source,
            href: action.href,
            label,
          });
        }
      }
    }
    if (groupIndex[source] == null) {
      groupIndex[source] = groups.length;
      groups.push({ source, rows: [row] });
    } else {
      groups[groupIndex[source]].rows.push(row);
    }
  }

  const asOf = publicAsOf(fields.asOf);
  const freshnessRaw = publicCitationTrust(fields.freshness);
  for (const group of groups) {
    const trust = publicCitationTrust(weakestTrust(group.rows.map(row => row.trust)));
    const freshness = freshnessRaw && freshnessRaw !== trust ? freshnessRaw : null;
    const label = provenanceText({
      source: group.source,
      asOf,
      trust,
      freshness,
    });
    if (label) {
      items.push({
        kind: 'provenance',
        source: group.source,
        asOf,
        trust,
        freshness,
        label,
      });
    }
  }
  return sanitizeCitations(items) || assembleCitations(fields);
}

function sanitizePresentationCards(cards) {
  if (!cards || typeof cards !== 'object' || Array.isArray(cards)) return null;
  if (cards.version !== CARD_VERSION) return null;
  if (!Array.isArray(cards.items) || !cards.items.length) return null;
  const items = [];
  for (const raw of cards.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!CARD_KINDS[raw.kind]) return null;
    if (typeof raw.title !== 'string' || !raw.title) return null;
    if (typeof raw.body !== 'string' || !raw.body) return null;
    if (raw.kind === 'action') {
      const action = publicAction({ href: raw.href, label: raw.label || raw.body });
      if (!action) return null;
      items.push({
        kind: 'action',
        title: raw.title,
        body: action.label,
        href: action.href,
        label: action.label,
      });
      continue;
    }
    items.push({
      kind: raw.kind,
      title: raw.title,
      body: raw.body,
    });
  }
  return items.length ? { version: CARD_VERSION, items } : null;
}

function uniqueMappedSurfaces(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  if (rows.some(row => !row || !row.mapped)) return [];
  const surfaces = [];
  const seen = Object.create(null);
  for (const row of rows) {
    const source = ALLOWED_SOURCES.includes(row.source) ? row.source : null;
    const action = publicAction(row.action);
    if (!source || !action) continue;
    const key = source + '\0' + action.href;
    if (!seen[key]) {
      seen[key] = { source, action, trusts: [] };
      surfaces.push(seen[key]);
    }
    seen[key].trusts.push(row.trust);
  }
  return surfaces.map(surface => ({
    source: surface.source,
    action: surface.action,
    trust: weakestTrust(surface.trusts) || null,
  }));
}

function trailingMetaCard(fields) {
  const items = [];
  const provenance = provenanceText(fields);
  if (provenance) {
    items.push({ kind: 'provenance', title: 'Source', body: provenance });
  }
  const action = publicAction(fields.action);
  if (action) {
    items.push({
      kind: 'action',
      title: 'Open',
      body: action.label,
      href: action.href,
      label: action.label,
    });
  }
  return items;
}

function trailingMetaCards(presentation, claimRows) {
  const surfaces = uniqueMappedSurfaces(claimRows);
  if (surfaces.length > 1) {
    const items = [];
    for (const surface of surfaces) {
      items.push(...trailingMetaCard({
        source: surface.source,
        action: surface.action,
        trust: surface.trust,
        asOf: presentation.asOf,
        freshness: presentation.freshness,
      }));
    }
    return items;
  }
  return trailingMetaCard(presentation);
}

function uniqueStrings(values) {
  const out = [];
  const seen = Object.create(null);
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen[value]) continue;
    seen[value] = true;
    out.push(value);
  }
  return out;
}

function sectionItems(bodies) {
  return uniqueStrings(bodies).map(body => ({ body }));
}

function objectKeysAllowed(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  for (const key of keys) {
    if (!allowed[key]) return false;
  }
  return true;
}

function sanitizeDecisionSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  if (summary.version !== SUMMARY_VERSION) return null;
  if (!objectKeysAllowed(summary, { version: true, sections: true })) return null;
  if (!Array.isArray(summary.sections) || summary.sections.length !== SUMMARY_SECTION_ORDER.length) {
    return null;
  }
  const sections = [];
  for (let i = 0; i < SUMMARY_SECTION_ORDER.length; i += 1) {
    const raw = summary.sections[i];
    const key = SUMMARY_SECTION_ORDER[i];
    const title = SUMMARY_TITLES[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!objectKeysAllowed(raw, { key: true, title: true, items: true })) return null;
    if (raw.key !== key || raw.title !== title) return null;
    if (!Array.isArray(raw.items) || !raw.items.length) return null;
    const items = [];
    for (const item of raw.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      if (!objectKeysAllowed(item, { body: true })) return null;
      if (typeof item.body !== 'string' || !item.body || item.body.length > 2000) return null;
      items.push({ body: item.body });
    }
    sections.push({ key, title, items });
  }
  return { version: SUMMARY_VERSION, sections };
}

function trustedSummaryPool(presentation, extras) {
  const pool = Object.create(null);
  const closed = Object.keys(SUMMARY_CLOSED);
  for (let i = 0; i < closed.length; i += 1) {
    pool[SUMMARY_CLOSED[closed[i]]] = true;
  }
  if (presentation && typeof presentation.answer === 'string' && presentation.answer) {
    pool[presentation.answer] = true;
  }
  const leading = extras && Array.isArray(extras.items) ? extras.items : [];
  for (const item of leading) {
    if (item && typeof item.body === 'string' && item.body) pool[item.body] = true;
  }
  const claimRows = extras && Array.isArray(extras.claimRows) ? extras.claimRows : [];
  for (const row of claimRows) {
    if (row && typeof row.text === 'string' && row.text) pool[row.text] = true;
  }
  const citations = presentation && Array.isArray(presentation.citations)
    ? presentation.citations
    : [];
  for (const cite of citations) {
    if (cite && typeof cite.label === 'string' && cite.label) pool[cite.label] = true;
  }
  const provenance = presentation ? provenanceText(presentation) : null;
  if (provenance) pool[provenance] = true;
  return pool;
}

function everySummaryBodyTrusted(summary, pool) {
  if (!summary || !Array.isArray(summary.sections)) return false;
  for (const section of summary.sections) {
    if (!section || !Array.isArray(section.items)) return false;
    for (const item of section.items) {
      if (!item || typeof item.body !== 'string' || !pool[item.body]) return false;
    }
  }
  return true;
}

function trustRiskSentences(trust, freshness) {
  const sentences = [];
  if (trust === 'unavailable') sentences.push(SUMMARY_CLOSED.unavailableNotNumber);
  if (trust === 'unknown') sentences.push(SUMMARY_CLOSED.unknownNotFigure);
  if (trust === 'dated-opening') sentences.push(SUMMARY_CLOSED.datedOpeningNotCurrent);
  if (trust === 'estimated') sentences.push(SUMMARY_CLOSED.estimatedNotConfirmed);
  if (trust === 'stale' || freshness === 'stale') sentences.push(SUMMARY_CLOSED.staleNotCurrent);
  if (freshness === 'estimated' && trust !== 'estimated') {
    sentences.push(SUMMARY_CLOSED.estimatedNotConfirmed);
  }
  return sentences;
}

function noteSummaryBucket(body) {
  if (/Conversation history is not household-financial evidence/.test(body)
      || /already-published Forecast baseline/.test(body)) {
    return 'risk';
  }
  return 'unchanged';
}

function assembleDecisionSummary(presentation, extras) {
  try {
    if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
      return null;
    }
    extras = extras || {};
    const leading = Array.isArray(extras.items) ? extras.items : [];
    const knows = [];
    const changes = [];
    const unchanged = [];
    const risk = [];
    const unknown = [];

    for (const item of leading) {
      if (!item || typeof item.body !== 'string' || !item.body) continue;
      if (item.kind === 'answer') {
        knows.push(item.body);
      } else if (item.kind === 'option') {
        changes.push(item.body);
      } else if (item.kind === 'result') {
        if (item.title === 'Already published') knows.push(item.body);
        else changes.push(item.body);
      } else if (item.kind === 'judgment') {
        if (/NOT YET \/ INDETERMINATE/.test(item.body)) unknown.push(item.body);
        else knows.push(item.body);
      } else if (item.kind === 'note') {
        if (noteSummaryBucket(item.body) === 'risk') risk.push(item.body);
        else unchanged.push(item.body);
      }
    }

    const claimRows = Array.isArray(extras.claimRows) ? extras.claimRows : [];
    for (const row of claimRows) {
      if (!row || typeof row.text !== 'string' || !row.text) continue;
      if (row.mapped === false || row.trust === 'unavailable') {
        unknown.push(row.text);
      }
    }

    if (!knows.length && typeof presentation.answer === 'string' && presentation.answer) {
      knows.push(presentation.answer);
    }
    if (!changes.length) changes.push(SUMMARY_CLOSED.noForecastChange);
    if (!unchanged.length) {
      const hasForecastChange = changes.some(function (body) {
        return body !== SUMMARY_CLOSED.noForecastChange;
      });
      unchanged.push(
        hasForecastChange
          ? SUMMARY_CLOSED.reprintsForecastChange
          : SUMMARY_CLOSED.reprintsOnly
      );
    }

    const citations = Array.isArray(presentation.citations) ? presentation.citations : [];
    for (const cite of citations) {
      if (cite && cite.kind === 'provenance' && typeof cite.label === 'string' && cite.label) {
        risk.push(cite.label);
      }
    }
    const provenance = provenanceText(presentation);
    if (provenance) risk.push(provenance);
    const trustSentences = trustRiskSentences(presentation.trust, presentation.freshness);
    for (const sentence of trustSentences) risk.push(sentence);
    if (!risk.length) risk.push(SUMMARY_CLOSED.freshnessUnavailable);

    if (!unknown.length) unknown.push(SUMMARY_CLOSED.packetOnly);
    if (!knows.length) return null;

    const draft = {
      version: SUMMARY_VERSION,
      sections: [
        { key: 'knows', title: SUMMARY_TITLES.knows, items: sectionItems(knows) },
        { key: 'changes', title: SUMMARY_TITLES.changes, items: sectionItems(changes) },
        { key: 'unchanged', title: SUMMARY_TITLES.unchanged, items: sectionItems(unchanged) },
        { key: 'risk', title: SUMMARY_TITLES.risk, items: sectionItems(risk) },
        { key: 'unknown', title: SUMMARY_TITLES.unknown, items: sectionItems(unknown) },
      ],
    };
    const pool = trustedSummaryPool(presentation, extras);
    if (!everySummaryBodyTrusted(draft, pool)) return null;
    return sanitizeDecisionSummary(draft);
  } catch (err) {
    return null;
  }
}

function finishPresentation(presentation, extras) {
  const leading = extras && Array.isArray(extras.items) ? extras.items : [];
  const claimRows = extras && extras.claimRows;
  presentation.cards = sanitizePresentationCards({
    version: CARD_VERSION,
    items: leading.concat(trailingMetaCards(presentation, claimRows)),
  });
  presentation.citations = Array.isArray(claimRows)
    ? assembleClaimCitations(claimRows, presentation)
    : assembleCitations(presentation);
  try {
    presentation.summary = assembleDecisionSummary(presentation, extras);
  } catch (err) {
    presentation.summary = null;
  }
  return presentation;
}

function emptyPresentation(answer, extras) {
  extras = extras || {};
  return finishPresentation({
    answer,
    source: extras.source || null,
    trust: extras.trust || null,
    asOf: extras.asOf || null,
    freshness: extras.freshness || null,
    action: extras.action || null,
  }, {
    items: [{ kind: 'answer', title: 'Answer', body: answer }],
  });
}

function hypotheticalConsequenceSentences(result) {
  const sentences = [];
  const absorbed = result && result.absorbed;
  if (absorbed && Number.isFinite(Number(absorbed.amount))) {
    const applied = formatCurrency(absorbed.amount);
    if (applied) {
      let line = `Forecast absorbs ${applied} on that date.`;
      if (Number.isFinite(Number(absorbed.unabsorbed)) && Number(absorbed.unabsorbed) > 0) {
        const leftover = formatCurrency(absorbed.unabsorbed);
        if (leftover) line += ` ${leftover} is not absorbed.`;
      }
      sentences.push(line);
    }
  }
  const dDebt = result && result.delta && result.delta.debt;
  const sDebt = result && result.scenario && result.scenario.debt;
  const bDebt = result && result.baseline && result.baseline.debt;
  if (dDebt && Number.isFinite(Number(dDebt.ending))
      && sDebt && Number.isFinite(Number(sDebt.ending))
      && bDebt && Number.isFinite(Number(bDebt.ending))) {
    const delta = formatCurrency(dDebt.ending);
    const ending = formatCurrency(sDebt.ending);
    const prior = formatCurrency(bDebt.ending);
    if (delta && ending && prior) {
      sentences.push(
        `Named-debt ending balance changes by ${delta} over the Forecast window, to ${ending} from ${prior}.`
      );
    }
  }
  if (dDebt && Number.isFinite(Number(dDebt.interest))) {
    const interest = formatCurrency(dDebt.interest);
    if (interest) {
      sentences.push(`Interest over the Forecast window changes by ${interest}.`);
    }
  }
  if (dDebt && Number.isFinite(Number(dDebt.paid))) {
    const paid = formatCurrency(dDebt.paid);
    if (paid) {
      sentences.push(`Named-debt paid over the Forecast window changes by ${paid}.`);
    }
  }
  if (dDebt && Number.isFinite(Number(dDebt.availableCredit))) {
    const credit = formatCurrency(dDebt.availableCredit);
    if (credit) {
      sentences.push(
        `Available credit changes by ${credit}. Available credit is not cash.`
      );
    }
  }
  const dCash = result && result.delta && result.delta.cash;
  if (dCash && Number.isFinite(Number(dCash.ending))) {
    const cash = formatCurrency(dCash.ending);
    if (cash) {
      sentences.push(
        `Household cash ending changes by ${cash}. This extra amount is not available cash or safe-to-spend.`
      );
    }
  }
  if (dCash && Number.isFinite(Number(dCash.min))) {
    const min = formatCurrency(dCash.min);
    if (min) {
      sentences.push(`The Forecast-window cash minimum changes by ${min}.`);
    }
  }
  if (dCash && Number.isFinite(Number(dCash.extra))) {
    const extra = formatCurrency(dCash.extra);
    if (extra) {
      sentences.push(`Forecast extra-cash totals change by ${extra}.`);
    }
  }
  if (result && result.delta && result.delta.payoff
      && result.delta.payoff.clearedWithinWindow === true) {
    sentences.push('Forecast says the named debt would clear within the current window.');
  }
  return sentences;
}

function presentHypotheticalExtra(result, packet) {
  const asOf = (result && result.input && result.input.asOf) || readAsOf(packet);
  const freshness = readFreshness(packet);
  if (!result || result.status !== 'ready') {
    return emptyPresentation(HYPOTHETICAL_UNAVAILABLE_ANSWER, {
      source: 'Forecast',
      trust: 'unavailable',
      asOf,
      freshness,
    });
  }
  const amountText = formatCurrency(result.input && result.input.amount);
  const label = result.input && typeof result.input.debtLabel === 'string'
    ? result.input.debtLabel
    : '';
  const day = result.input && result.input.asOf;
  if (!amountText || !label || typeof day !== 'string' || !day) {
    return emptyPresentation(HYPOTHETICAL_UNAVAILABLE_ANSWER, {
      source: 'Forecast',
      trust: 'unavailable',
      asOf,
      freshness,
    });
  }
  const lead = `If you put ${amountText} on ${label} as a hypothetical extra on ${day}:`;
  const consequences = hypotheticalConsequenceSentences(result);
  const note = 'This is a hypothetical scenario from Forecast and is not a recommendation.';
  const sentences = [lead].concat(consequences);
  sentences.push(note);
  return finishPresentation({
    answer: sentences.join(' '),
    source: 'Forecast',
    trust: 'calculated',
    asOf: day,
    freshness,
    action: null,
  }, {
    items: [{ kind: 'answer', title: 'Answer', body: lead }]
      .concat(consequences.map(body => ({
        kind: 'result',
        title: 'Forecast result',
        body,
      })))
      .concat([{ kind: 'note', title: 'Note', body: note }]),
  });
}

function comparisonOptionLabel(index, count) {
  if (count === 2) return `Option ${index === 0 ? 'A' : 'B'}`;
  return `Option ${index + 1}`;
}

function preferenceReasonSentence(reason) {
  if (reason === 'cash-endings-differ') {
    return 'Household cash-ending consequences differ, so Atlas has no owner authority to prefer one option.';
  }
  if (reason === 'not-fully-absorbed') {
    return 'An explicit payment is not fully absorbed by its named debt.';
  }
  if (reason === 'interest-reductions-equal') {
    return 'Forecast-calculated named-debt interest reductions are not strictly different.';
  }
  if (reason === 'not-exactly-two-options') {
    return 'The owner preference rule applies only to exactly two explicit options.';
  }
  return 'Required Forecast comparison fields are unavailable. Unavailable is not zero.';
}

function presentPreferenceSentence(preference) {
  if (!preference || typeof preference !== 'object') return null;
  if (preference.verdict === 'PREFER' && preference.preferred) {
    const amountText = formatCurrency(preference.preferred.amount);
    const label = typeof preference.preferred.debtLabel === 'string'
      ? preference.preferred.debtLabel
      : '';
    if (!amountText || !label) {
      return [
        'NOT YET / INDETERMINATE.',
        preferenceReasonSentence('unavailable'),
        'This is not a payment authority and not a recommendation to execute.',
      ].join(' ');
    }
    return [
      `PREFER ${amountText} on ${label}.`,
      'That option produces a strictly greater Forecast-calculated reduction in named-debt interest over the same household cash-ending and Forecast window.',
      'This is a conversational preference from the owner rule, not a payment authority and not a recommendation to execute.',
    ].join(' ');
  }
  return [
    'NOT YET / INDETERMINATE.',
    preferenceReasonSentence(preference.reason),
    'This is not a payment authority and not a recommendation to execute.',
  ].join(' ');
}

function presentHypotheticalComparison(result, packet, preference) {
  const asOf = (result && result.baseline && result.baseline.asOf) || readAsOf(packet);
  const freshness = readFreshness(packet);
  if (!result || result.status !== 'ready'
      || !Array.isArray(result.scenarios) || result.scenarios.length < 2) {
    return emptyPresentation(HYPOTHETICAL_COMPARISON_UNAVAILABLE_ANSWER, {
      source: 'Forecast',
      trust: 'unavailable',
      asOf,
      freshness,
    });
  }
  const day = result.baseline && result.baseline.asOf;
  const horizon = result.baseline && result.baseline.horizonDays;
  if (typeof day !== 'string' || !day || !Number.isFinite(Number(horizon))) {
    return emptyPresentation(HYPOTHETICAL_COMPARISON_UNAVAILABLE_ANSWER, {
      source: 'Forecast',
      trust: 'unavailable',
      asOf,
      freshness,
    });
  }
  const optionLines = [];
  const optionItems = [];
  for (let i = 0; i < result.scenarios.length; i += 1) {
    const row = result.scenarios[i];
    const input = row && row.input;
    const inner = row && row.result;
    const amountText = formatCurrency(input && input.amount);
    const label = input && typeof input.debtLabel === 'string' ? input.debtLabel : '';
    if (!amountText || !label || !inner || inner.status !== 'ready') {
      return emptyPresentation(HYPOTHETICAL_COMPARISON_UNAVAILABLE_ANSWER, {
        source: 'Forecast',
        trust: 'unavailable',
        asOf: day,
        freshness,
      });
    }
    const body = hypotheticalConsequenceSentences(inner);
    const optionTitle = comparisonOptionLabel(i, result.scenarios.length);
    const optionBody = `If you put ${amountText} on ${label} as a hypothetical extra on ${day}: ${body.join(' ')}`;
    optionLines.push(`${optionTitle} — ${optionBody}`);
    optionItems.push({ kind: 'option', title: optionTitle, body: optionBody });
  }
  const header = `Hypothetical comparison · Forecast as of ${day}. The Forecast window is ${Number(horizon)} days.`;
  const sentences = [header].concat(optionLines);
  const preferenceSentence = presentPreferenceSentence(preference);
  const note = 'This is a hypothetical comparison from Forecast and is not a recommendation. Forecast does not rank these options.';
  const items = [{ kind: 'answer', title: 'Answer', body: header }].concat(optionItems);
  if (preferenceSentence) {
    sentences.push(preferenceSentence);
    items.push({ kind: 'judgment', title: 'Preference', body: preferenceSentence });
  } else {
    sentences.push(note);
    items.push({ kind: 'note', title: 'Note', body: note });
  }
  return finishPresentation({
    answer: sentences.join(' '),
    source: 'Forecast',
    trust: 'calculated',
    asOf: day,
    freshness,
    action: null,
  }, { items });
}

function whyHypotheticalSentence(result) {
  const amountText = formatCurrency(result && result.priorAmount);
  const label = result && typeof result.priorDebtLabel === 'string'
    ? result.priorDebtLabel
    : '';
  if (!amountText || !label) return null;
  return `Atlas published a Forecast hypothetical extra of ${amountText} on ${label}. Forecast computed those already-published consequences.`;
}

function whyComparisonSentence(result) {
  if (!result || !Array.isArray(result.priorScenarios) || result.priorScenarios.length < 2) {
    return null;
  }
  const parts = [];
  for (const row of result.priorScenarios) {
    const amountText = formatCurrency(row && row.amount);
    const label = row && typeof row.debtLabel === 'string' ? row.debtLabel : '';
    if (!amountText || !label) return null;
    parts.push(`${amountText} on ${label}`);
  }
  return `Atlas published a Forecast hypothetical comparison of ${parts.join(' versus ')}. Forecast computed those already-published consequences.`;
}

function whyCalculationBaseline(result) {
  if (!result || (result.priorKind !== 'hypothetical' && result.priorKind !== 'comparison')) {
    return null;
  }
  const asOf = typeof result.asOf === 'string' && result.asOf ? result.asOf : null;
  if (!asOf) return null;
  const freshness = typeof result.freshness === 'string' && result.freshness
    ? result.freshness
    : null;
  return { asOf, freshness };
}

function presentWhyExplanation(result, packet) {
  const packetAsOf = readAsOf(packet);
  const packetFreshness = readFreshness(packet);
  const storedBaseline = whyCalculationBaseline(result);
  if (!result || result.status !== 'ready') {
    if (result && result.reason === 'stale-baseline') {
      return emptyPresentation(WHY_UNAVAILABLE_ANSWER, {
        source: 'Forecast',
        trust: 'unavailable',
        asOf: null,
        freshness: null,
      });
    }
    return emptyPresentation(WHY_UNAVAILABLE_ANSWER, {
      trust: 'unavailable',
      asOf: packetAsOf,
      freshness: packetFreshness,
    });
  }

  if ((result.priorKind === 'hypothetical' || result.priorKind === 'comparison')
      && !storedBaseline) {
    return emptyPresentation(WHY_UNAVAILABLE_ANSWER, {
      source: 'Forecast',
      trust: 'unavailable',
      asOf: null,
      freshness: null,
    });
  }

  const asOf = storedBaseline ? storedBaseline.asOf : packetAsOf;
  const freshness = storedBaseline ? storedBaseline.freshness : packetFreshness;

  const sentences = [];
  const items = [];
  const claimRows = [];
  const lead = typeof result.lead === 'string' && result.lead ? result.lead : WHY_LEAD;
  sentences.push(lead);
  items.push({ kind: 'answer', title: 'Answer', body: lead });

  if (result.priorKind === 'hypothetical') {
    const body = whyHypotheticalSentence(result);
    if (!body) {
      return emptyPresentation(WHY_UNAVAILABLE_ANSWER, {
        source: 'Forecast',
        trust: 'unavailable',
        asOf: storedBaseline.asOf,
        freshness: storedBaseline.freshness,
      });
    }
    sentences.push(body);
    items.push({ kind: 'result', title: 'Already published', body });
  } else if (result.priorKind === 'comparison') {
    const body = whyComparisonSentence(result);
    if (!body) {
      return emptyPresentation(WHY_UNAVAILABLE_ANSWER, {
        source: 'Forecast',
        trust: 'unavailable',
        asOf: storedBaseline.asOf,
        freshness: storedBaseline.freshness,
      });
    }
    sentences.push(body);
    items.push({ kind: 'result', title: 'Already published', body });
  }

  const claims = Array.isArray(result.claims) ? result.claims : [];
  for (const claim of claims) {
    if (!claim || typeof claim.path !== 'string' || !isPrimitive(claim.value)) continue;
    const row = presentClaim(claim, packet);
    claimRows.push(row);
    sentences.push(row.text);
    items.push({
      kind: 'result',
      title: 'Already published',
      body: row.mapped ? row.text : genericSentence(claim),
    });
  }

  if (!claimRows.length && result.priorKind !== 'hypothetical' && result.priorKind !== 'comparison') {
    return emptyPresentation(WHY_UNAVAILABLE_ANSWER, {
      trust: 'unavailable',
      asOf,
      freshness,
    });
  }

  sentences.push(WHY_NOTE);
  items.push({ kind: 'note', title: 'Note', body: WHY_NOTE });
  if (storedBaseline) {
    sentences.push(WHY_BASELINE_NOTE);
    items.push({ kind: 'note', title: 'Note', body: WHY_BASELINE_NOTE });
  } else if (result.priorKind) {
    sentences.push(WHY_HISTORY_NOTE);
    items.push({ kind: 'note', title: 'Note', body: WHY_HISTORY_NOTE });
  }

  const mapped = claimRows.filter(row => row.mapped);
  const unmapped = claimRows.filter(row => !row.mapped);
  const hypSource = (result.priorKind === 'hypothetical' || result.priorKind === 'comparison')
    ? 'Forecast'
    : null;
  const source = hypSource || (unmapped.length ? null : sharedValue(mapped.map(row => row.source)));
  const action = unmapped.length ? null : publicAction(sharedValue(mapped.map(row => row.action)));
  const trust = hypSource
    ? 'calculated'
    : (weakestTrust(claimRows.map(row => row.trust)) || null);
  return finishPresentation({
    answer: sentences.join(' '),
    source,
    trust,
    asOf,
    freshness,
    action,
  }, { items, claimRows: claimRows.length ? claimRows : undefined });
}

function remainingBillsPacketState(packet) {
  const action = packetGet(packet, 'forecast.currentPeriodAction');
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { status: 'unavailable' };
  }
  if (action.status !== 'ok') {
    return { status: 'unavailable' };
  }
  if (!Array.isArray(action.bills)) return { status: 'unavailable' };
  return {
    status: 'ok',
    items: action.bills,
  };
}

function forecastBillsBySettlement(items, settlement) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => item && item.settlement === settlement);
}

function forecastStillDueBills(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => item && (
    item.settlement === 'upcoming' || item.settlement === 'unverified'
  ));
}

function remainingBillMoney(value) {
  return formatCurrency(value);
}

function remainingBillLabel(item) {
  if (item && typeof item.label === 'string' && item.label.trim()) return item.label.trim();
  if (item && typeof item.id === 'string' && item.id.trim()) return item.id.trim();
  return '';
}

function remainingBillAmount(item) {
  if (!item) return null;
  if (item.settlement === 'represented') {
    return remainingBillMoney(item.actual != null ? item.actual : item.planned);
  }
  if (item.settlement === 'pending') return remainingBillMoney(item.planned);
  if (item.remaining != null) return remainingBillMoney(item.remaining);
  return remainingBillMoney(item.planned);
}

function remainingBillSentence(item) {
  if (!item || typeof item !== 'object') return null;
  const label = remainingBillLabel(item);
  const amount = remainingBillAmount(item);
  const date = typeof item.date === 'string' && item.date ? item.date : '';
  if (!label || !amount || !date) return null;
  const estimated = item.confidence === 'estimated' ? ' (estimated)' : '';
  if (item.settlement === 'unverified') {
    return `${label} was scheduled ${date} for ${amount}${estimated}. ${REMAINING_BILLS_UNVERIFIED_NOTE}`;
  }
  if (item.settlement === 'upcoming') {
    return `${label} is still due ${date} for ${amount}${estimated}.`;
  }
  if (item.settlement === 'pending') {
    return `${label} has a payment pending for its ${date} bill (planned ${amount}${estimated}). It has not posted yet. That is not still due.`;
  }
  if (item.settlement === 'represented') {
    return `${label} is represented ${date} for ${amount}${estimated}. That is not still due.`;
  }
  return `${label} is listed ${date} for ${amount}${estimated}. Forecast settlement for that item is unavailable.`;
}

function remainingBillsNotListedSentence(label) {
  const named = typeof label === 'string' && label.trim() ? label.trim() : 'that bill';
  return `Forecast does not list ${named} among this payday period's bills.`;
}

function presentPaydayRemainingBills(resolved, packet) {
  const asOf = readAsOf(packet);
  const freshness = readFreshness(packet);
  const unavailable = () => emptyPresentation(REMAINING_BILLS_UNAVAILABLE_ANSWER, {
    source: 'Forecast',
    trust: 'unavailable',
    asOf,
    freshness,
    action: ALLOWED_ACTIONS.bills,
  });
  if (!resolved || resolved.status !== 'resolved-reference'
      || resolved.referentKey !== 'payday-remaining-bills') {
    return unavailable();
  }
  const state = remainingBillsPacketState(packet);
  if (state.status !== 'ok') return unavailable();

  const ask = resolved.ask;
  const items = [];
  const sentences = [];

  if (ask === 'covered') {
    const covered = forecastBillsBySettlement(state.items, 'represented');
    if (!covered.length) {
      sentences.push(REMAINING_BILLS_COVERED_EMPTY);
      items.push({ kind: 'answer', title: 'Answer', body: REMAINING_BILLS_COVERED_EMPTY });
      return finishPresentation({
        answer: sentences.join(' '),
        source: 'Forecast',
        trust: 'calculated',
        asOf,
        freshness,
        action: ALLOWED_ACTIONS.bills,
      }, { items });
    }
    sentences.push(REMAINING_BILLS_COVERED_LEAD);
    items.push({ kind: 'answer', title: 'Answer', body: REMAINING_BILLS_COVERED_LEAD });
    for (const row of covered) {
      const body = remainingBillSentence(row);
      if (!body) return unavailable();
      sentences.push(body);
      items.push({ kind: 'result', title: 'Already published', body });
    }
    return finishPresentation({
      answer: sentences.join(' '),
      source: 'Forecast',
      trust: 'calculated',
      asOf,
      freshness,
      action: ALLOWED_ACTIONS.bills,
    }, { items });
  }

  if (ask === 'named') {
    const listed = state.items;
    const query = resolved.billLabel || resolved.billId || '';
    let found = null;
    if (resolved.billId) {
      const byId = listed.filter(row => row && row.id === resolved.billId);
      found = byId.length === 1 ? byId[0] : null;
      if (byId.length > 1) return unavailable();
    } else if (query) {
      const q = String(query).toLowerCase();
      const matches = listed.filter((row) => {
        const id = row && typeof row.id === 'string' ? row.id.toLowerCase() : '';
        const label = row && typeof row.label === 'string' ? row.label.toLowerCase() : '';
        return (id && (id === q || id.indexOf(q) !== -1 || q.indexOf(id) !== -1))
          || (label && (label === q || label.indexOf(q) !== -1 || q.indexOf(label) !== -1));
      });
      if (matches.length > 1) return unavailable();
      found = matches.length === 1 ? matches[0] : null;
    }
    if (!found) {
      const body = remainingBillsNotListedSentence(query);
      sentences.push(body);
      items.push({ kind: 'answer', title: 'Answer', body });
      return finishPresentation({
        answer: sentences.join(' '),
        source: 'Forecast',
        trust: 'calculated',
        asOf,
        freshness,
        action: ALLOWED_ACTIONS.bills,
      }, { items });
    }
    const body = remainingBillSentence(found);
    if (!body) return unavailable();
    sentences.push(body);
    items.push({ kind: 'answer', title: 'Answer', body });
    return finishPresentation({
      answer: sentences.join(' '),
      source: 'Forecast',
      trust: found.confidence === 'estimated' ? 'estimated' : 'calculated',
      asOf,
      freshness,
      action: ALLOWED_ACTIONS.bills,
    }, { items });
  }

  const stillDue = forecastStillDueBills(state.items);
  // A payment in flight is not still due, and it is not paid either.
  const pendingRows = forecastBillsBySettlement(state.items, 'pending');
  const pendingNotes = pendingRows.map(remainingBillSentence);
  // Answer trust is the weakest confidence of every bill row printed,
  // pending rows included (#907 review): never promoted to calculated.
  const printedTrust = rows => rows.some(row => row && row.confidence === 'estimated')
    ? 'estimated' : 'calculated';
  if (pendingNotes.some(body => !body)) return unavailable();
  if (!stillDue.length) {
    sentences.push(REMAINING_BILLS_EMPTY_ANSWER);
    items.push({ kind: 'answer', title: 'Answer', body: REMAINING_BILLS_EMPTY_ANSWER });
    for (const body of pendingNotes) {
      sentences.push(body);
      items.push({ kind: 'result', title: 'Payment pending', body });
    }
    return finishPresentation({
      answer: sentences.join(' '),
      source: 'Forecast',
      trust: printedTrust(pendingRows),
      asOf,
      freshness,
      action: ALLOWED_ACTIONS.bills,
    }, { items });
  }

  sentences.push(REMAINING_BILLS_LEAD);
  items.push({ kind: 'answer', title: 'Answer', body: REMAINING_BILLS_LEAD });
  for (const row of stillDue) {
    const body = remainingBillSentence(row);
    if (!body) return unavailable();
    sentences.push(body);
    items.push({ kind: 'result', title: 'Already published', body });
  }
  for (const body of pendingNotes) {
    sentences.push(body);
    items.push({ kind: 'result', title: 'Payment pending', body });
  }
  return finishPresentation({
    answer: sentences.join(' '),
    source: 'Forecast',
    trust: printedTrust(stillDue.concat(pendingRows)),
    asOf,
    freshness,
    action: ALLOWED_ACTIONS.bills,
  }, { items });
}

function presentVerifiedClaims(published, packet) {
  if (!published || published.status === 'unavailable') {
    return emptyPresentation(UNAVAILABLE_ANSWER, {
      trust: 'unavailable',
      asOf: readAsOf(packet),
      freshness: readFreshness(packet),
    });
  }
  const claims = Array.isArray(published.claims) ? published.claims : [];
  if (!claims.length) {
    return emptyPresentation(UNAVAILABLE_ANSWER, {
      trust: 'unavailable',
      asOf: readAsOf(packet),
      freshness: readFreshness(packet),
    });
  }
  const presented = claims.map(claim => presentClaim(claim, packet));
  const mapped = presented.filter(row => row.mapped);
  const unmapped = presented.filter(row => !row.mapped);
  const answer = !mapped.length
    ? assembleGenericAnswer(claims)
    : presented.map((row, index) => (
      row.mapped ? row.text : genericSentence(claims[index])
    )).join(' ');
  const source = unmapped.length ? null : sharedValue(mapped.map(row => row.source));
  const action = unmapped.length ? null : publicAction(sharedValue(mapped.map(row => row.action)));
  return finishPresentation({
    answer,
    source,
    trust: weakestTrust(presented.map(row => row.trust)),
    asOf: readAsOf(packet),
    freshness: readFreshness(packet),
    action,
  }, {
    items: presented.map((row, index) => ({
      kind: 'answer',
      title: 'Answer',
      body: row.mapped ? row.text : genericSentence(claims[index]),
    })),
    claimRows: presented,
  });
}

function isAllowedActionHref(href) {
  return ALLOWED_ACTION_HREFS.includes(href);
}

module.exports = {
  UNAVAILABLE_ANSWER,
  REMAINING_BILLS_UNAVAILABLE_ANSWER,
  REMAINING_BILLS_EMPTY_ANSWER,
  REMAINING_BILLS_COVERED_LEAD,
  REMAINING_BILLS_COVERED_EMPTY,
  REMAINING_BILLS_UNVERIFIED_NOTE,
  REMAINING_BILLS_LEAD,
  HYPOTHETICAL_UNAVAILABLE_ANSWER,
  HYPOTHETICAL_COMPARISON_UNAVAILABLE_ANSWER,
  WHY_UNAVAILABLE_ANSWER,
  WHY_LEAD,
  WHY_NOTE,
  WHY_HISTORY_NOTE,
  WHY_BASELINE_NOTE,
  ALLOWED_ACTIONS,
  ALLOWED_ACTION_HREFS,
  ALLOWED_SOURCES,
  SURFACE_LABELS,
  CITATION_KINDS,
  CITATION_TRUST,
  CARD_VERSION,
  CARD_KINDS,
  SUMMARY_VERSION,
  SUMMARY_SECTION_ORDER,
  SUMMARY_TITLES,
  SUMMARY_CLOSED,
  sanitizePresentationCards,
  sanitizeDecisionSummary,
  sanitizeCitations,
  assembleCitations,
  assembleClaimCitations,
  publicCitationTrust,
  formatCurrency,
  formatClaimValue,
  isPrimitive,
  ruleFor,
  presentVerifiedClaims,
  presentPaydayRemainingBills,
  presentWhyExplanation,
  presentHypotheticalExtra,
  presentHypotheticalComparison,
  isAllowedActionHref,
};
