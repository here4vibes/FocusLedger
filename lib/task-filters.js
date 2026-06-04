'use strict';

/**
 * Returns a SQL fragment that filters tasks to those actionable on or before
 * the given date parameter. Tasks with no due date are always included.
 *
 * @param {number} paramIndex - The $N index of the localDate parameter
 * @param {string} [tableAlias] - Optional table alias prefix (e.g. 't')
 * @returns {string} SQL fragment
 */
function actionableDateFilter(paramIndex, tableAlias) {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const param = `$${paramIndex}`;
  return `(${prefix}due_date IS NULL OR ${prefix}due_date <= ${param}::date)`;
}

module.exports = { actionableDateFilter };
