// ==UserScript==
// @name         Schoology Parent Dashboard
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Enhances Schoology grade reports with a parent concern summary panel
// @author       Parent Dashboard Team
// @match        https://*.schoology.com/grades*
// @match        https://*.schoology.com/course/*/grades*
// @match        https://*.schoology.com/user/*/grades*
// @match        https://*.schoology.com/parent/grades_attendance/grades*
// @match        https://*.schoology.com/parent/*/grades*
// @exclude      https://*.schoology.com/grades*?*past=*
// @exclude      https://*.schoology.com/course/*/grades*?*past=*
// @exclude      https://*.schoology.com/user/*/grades*?*past=*
// @exclude      https://*.schoology.com/parent/grades_attendance/grades*?*past=*
// @exclude      https://*.schoology.com/parent/*/grades*?*past=*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    /**
     * Configuration management for user preferences and concern thresholds
     */
    class ConfigurationManager {
        constructor() {
            this.storageKey = 'schoology-parent-dashboard-config';
            this.defaultConfig = {
                gradeThreshold: 70, // D or lower (70% and below)
                upcomingDaysWindow: 7, // 7 days for upcoming assignments
                practiceThreshold: 80, // Ignore missing practice assignments when course grade is above this %
                concernSensitivity: 'medium', // low, medium, high
                showLowGrades: true,
                showMissingAssignments: true,
                showNegativeComments: true,
                showUpcomingAssignments: true,
                panelCollapsed: false,
                sectionsDefaultExpanded: true, // true = expanded by default, false = collapsed by default
                hiddenCourses: ['Hereford Connections'] // Array of course name patterns to hide
            };
            this.config = this.loadConfig();
        }

        /**
         * Load configuration from localStorage with fallback to defaults
         * @returns {Object} Configuration object
         */
        loadConfig() {
            try {
                const stored = localStorage.getItem(this.storageKey);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    // Merge with defaults to handle new config options
                    return { ...this.defaultConfig, ...parsed };
                }
            } catch (error) {
                console.warn('ConfigurationManager: Error loading config, using defaults:', error);
            }
            return { ...this.defaultConfig };
        }

        /**
         * Save configuration to localStorage
         * @param {Object} config - Configuration object to save
         */
        saveConfig(config = null) {
            try {
                const configToSave = config || this.config;
                localStorage.setItem(this.storageKey, JSON.stringify(configToSave));
                if (config) {
                    this.config = { ...this.config, ...config };
                }
                console.log('ConfigurationManager: Configuration saved successfully');
            } catch (error) {
                console.error('ConfigurationManager: Error saving config:', error);
            }
        }

        /**
         * Get a specific configuration value
         * @param {string} key - Configuration key
         * @returns {*} Configuration value
         */
        get(key) {
            return this.config[key];
        }

        /**
         * Set a specific configuration value
         * @param {string} key - Configuration key
         * @param {*} value - Configuration value
         */
        set(key, value) {
            this.config[key] = value;
            this.saveConfig();
        }

        /**
         * Update multiple configuration values
         * @param {Object} updates - Object with key-value pairs to update
         */
        update(updates) {
            Object.assign(this.config, updates);
            this.saveConfig();
        }

        /**
         * Reset configuration to defaults
         */
        reset() {
            this.config = { ...this.defaultConfig };
            this.saveConfig();
        }

        /**
         * Get grade threshold as percentage for concern detection
         * @returns {number} Grade threshold percentage
         */
        getGradeThreshold() {
            return this.get('gradeThreshold');
        }

        /**
         * Get upcoming assignments time window in days
         * @returns {number} Number of days for upcoming assignment window
         */
        getUpcomingDaysWindow() {
            return this.get('upcomingDaysWindow');
        }

        /**
         * Check if a grade percentage is below the concern threshold
         * @param {number} percentage - Grade percentage to check
         * @returns {boolean} True if grade is concerning
         */
        isGradeConcerning(percentage) {
            if (typeof percentage !== 'number' || isNaN(percentage)) {
                return false;
            }
            return percentage <= this.getGradeThreshold();
        }

        /**
         * Check if an assignment is within the upcoming window
         * @param {Date} dueDate - Assignment due date
         * @returns {boolean} True if assignment is upcoming
         */
        isAssignmentUpcoming(dueDate) {
            if (!dueDate || !(dueDate instanceof Date)) {
                return false;
            }
            const now = new Date();
            const diffTime = dueDate.getTime() - now.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            return diffDays >= 0 && diffDays <= this.getUpcomingDaysWindow();
        }

        /**
         * Get sensitivity multiplier for concern detection
         * @returns {number} Multiplier for concern sensitivity
         */
        getSensitivityMultiplier() {
            const sensitivity = this.get('concernSensitivity');
            switch (sensitivity) {
                case 'low': return 0.7;
                case 'high': return 1.3;
                case 'medium':
                default: return 1.0;
            }
        }

        /**
         * Check if a course should be hidden from the dashboard
         * @param {string} courseName - Course name to check
         * @returns {boolean} True if course should be hidden
         */
        isCourseHidden(courseName) {
            if (!courseName) return false;

            const hiddenCourses = this.get('hiddenCourses') || [];
            return hiddenCourses.some(hiddenPattern =>
                courseName.toLowerCase().includes(hiddenPattern.toLowerCase())
            );
        }
    }

    /**
     * Data extraction engine for parsing Schoology DOM structure
     * Handles extraction of grades, assignments, and related data
     */
    class DataExtractor {
        constructor() {
            this.gradeSelectors = [
                // Prioritize selectors based on console analysis
                'tr.report-row.item-row',     // Most specific - matches what we found
                'tr.report-row',              // Broader report row selector  
                'tr[data-id]',               // All rows with data-id (256 found)
                'tr[class*="grade"]',        // Current working selector (3 found)
                // Common Schoology grade table selectors
                '.gradebook-table tbody tr',
                'table[class*="grade"] tbody tr',
                '.s-edge-type-gradebook .grade-row',
                '[data-drupal-selector*="grade"] tr',
                // Parent grades page selectors
                '.grade-row',
                '.assignment-row',
                '.gradebook-row'
            ];

            this.subjectSelectors = [
                '.course-title',
                '.gradebook-course-title',
                '.course-name',
                'h1',
                'h2',
                '.page-title'
            ];
        }

        /**
         * Detect the current marking period from the page
         * @returns {string} Current marking period ('MP1', 'MP2', 'MP3', 'MP4', 'Final', or 'current')
         */
        detectCurrentMarkingPeriod() {
            // Look for marking period indicators in the page
            const mpSelectors = [
                '.gradebook-course-title',
                '.period-selector',
                '.marking-period',
                'h1', 'h2', 'h3',
                '.page-title',
                '.course-header'
            ];

            for (const selector of mpSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const element of elements) {
                    const text = element.textContent.trim();

                    // Look for MP patterns like "MP 1 2025-2026", "MP1", "Marking Period 1", etc.
                    const mpMatch = text.match(/MP\s*(\d+)|Marking\s*Period\s*(\d+)|Quarter\s*(\d+)/i);
                    if (mpMatch) {
                        const mpNumber = mpMatch[1] || mpMatch[2] || mpMatch[3];
                        return `MP${mpNumber}`;
                    }

                    // Look for Final exam period
                    if (text.match(/Final\s*Exam|Final\s*Grade|Final\s*Period/i)) {
                        return 'Final';
                    }
                }
            }

            // Look for dropdown selectors or active period indicators
            const dropdownSelectors = [
                'select[name*="period"]',
                'select[name*="marking"]',
                '.period-dropdown',
                '.active-period'
            ];

            for (const selector of dropdownSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    const selectedValue = element.value || element.textContent;
                    const mpMatch = selectedValue.match(/MP\s*(\d+)|(\d+)/);
                    if (mpMatch) {
                        const mpNumber = mpMatch[1] || mpMatch[2];
                        return `MP${mpNumber}`;
                    }
                }
            }

            // Check URL parameters for marking period
            const urlParams = new URLSearchParams(window.location.search);
            const periodParam = urlParams.get('period') || urlParams.get('mp') || urlParams.get('marking_period');
            if (periodParam) {
                const mpMatch = periodParam.match(/(\d+)/);
                if (mpMatch) {
                    return `MP${mpMatch[1]}`;
                }
            }

            // Default to current if no specific period detected
            return 'current';
        }

        /**
         * Extract all grade entries from the page
         * @returns {Array} Array of grade objects
         */
        extractGrades() {
            const grades = [];

            // First, expand all collapsed subject sections to access all grades
            return this.expandAllSubjects().then(() => {

                // Try different selector strategies
                for (const selector of this.gradeSelectors) {
                    const rows = document.querySelectorAll(selector);
                    if (rows.length > 0) {
                        console.log(`DataExtractor: Found ${rows.length} grade rows using selector: ${selector}`);

                        rows.forEach(row => {
                            const gradeData = this.parseGradeRow(row);
                            if (gradeData) {
                                grades.push(gradeData);
                            }
                        });

                        if (grades.length > 0) {
                            break; // Use first successful selector strategy
                        }
                    }
                }

                console.log(`DataExtractor: Extracted ${grades.length} grade entries`);
                return grades;
            });
        }

        /**
         * Expand all collapsed subject sections to access all grades
         */
        expandAllSubjects() {
            console.log('Expanding all subject sections...');

            // Create a more targeted approach to minimize visual disruption
            const style = document.createElement('style');
            style.id = 'expansion-minimize-visual';
            style.textContent = `
                /* Speed up any Schoology-specific animations */
                .gradebook-course-title,
                .expandable-icon-grading-report,
                .report-row,
                .item-row,
                [class*="expand"],
                [class*="collapse"] {
                    transition-duration: 0.05s !important;
                    animation-duration: 0.05s !important;
                }
                
                /* Minimize visual changes during expansion */
                .gradebook-course-title .arrow {
                    transition: none !important;
                }
            `;
            document.head.appendChild(style);
            console.log('Applied fast expansion styles');

            // Count grades before expansion
            const gradesBefore = document.querySelectorAll('tr[class*="grade"]').length;
            console.log('Grades visible before expansion:', gradesBefore);

            // Look for the specific expandable icons that Schoology uses
            const expandableElements = [
                // The specific expandable icons we saw in the log
                '.expandable-icon-grading-report',
                // Course title links that can be clicked to expand
                '.gradebook-course-title a',
                // Arrow elements that indicate expandable sections
                '.arrow',
                'span.arrow'
            ];

            let expandedCount = 0;

            expandableElements.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                console.log(`Found ${elements.length} potentially expandable elements with selector: ${selector}`);

                elements.forEach(element => {
                    try {
                        // Check if element is actually expandable (has arrow or expand indicator)
                        const hasArrow = element.querySelector('.arrow') || element.classList.contains('arrow');
                        const hasExpandIndicator = element.textContent.includes('▶') || element.textContent.includes('►') ||
                            element.classList.toString().includes('expand') ||
                            element.classList.toString().includes('collapse');

                        if (hasArrow || hasExpandIndicator || selector.includes('gradebook-course-title')) {
                            // Reduced logging - only log summary
                            element.click();
                            expandedCount++;
                        }
                    } catch (error) {
                        console.log('Error expanding element:', error);
                    }
                });
            });

            console.log(`Expanded ${expandedCount} subject sections`);

            // Wait a moment for the DOM to update after expansions
            return new Promise(resolve => {
                const restoreTransitions = () => {
                    // Remove fast expansion styles
                    const fastStyle = document.getElementById('expansion-minimize-visual');
                    if (fastStyle) {
                        fastStyle.remove();
                        console.log('Removed fast expansion styles');
                    }
                };

                // Failsafe: restore styles after maximum wait time
                const failsafeTimeout = setTimeout(() => {
                    console.log('Failsafe: Removing fast expansion styles after timeout');
                    restoreTransitions();
                }, 2000); // Reduced from 5000ms to 2000ms

                setTimeout(() => {
                    // Count grades after expansion
                    const gradesAfter = document.querySelectorAll('tr[class*="grade"]').length;
                    console.log('Grades visible after expansion:', gradesAfter);

                    // If no new grades appeared, try a different approach
                    if (gradesAfter === gradesBefore) {
                        console.log('No new grades found after expansion, trying alternative selectors...');

                        // Try clicking on course title links directly
                        const courseTitles = document.querySelectorAll('.gradebook-course-title');
                        courseTitles.forEach((title, index) => {
                            console.log(`Clicking course title ${index + 1}:`, title.textContent.trim());
                            title.click();
                        });

                        // Wait a bit more and check again
                        setTimeout(() => {
                            const gradesFinal = document.querySelectorAll('tr[class*="grade"]').length;
                            console.log('Final grade count after course title clicks:', gradesFinal);

                            // Let's also check for other potential grade selectors after expansion
                            console.log('=== POST-EXPANSION GRADE ANALYSIS ===');
                            const postExpansionSelectors = [
                                'tr[class*="grade"]',
                                'tr[class*="assignment"]',
                                'tr[class*="item"]',
                                '.grade-item',
                                '.assignment-item',
                                'tr.report-row',
                                'tr[data-id]'
                            ];

                            postExpansionSelectors.forEach(selector => {
                                const elements = document.querySelectorAll(selector);
                                console.log(`Post-expansion ${selector}: ${elements.length} elements`);
                            });

                            console.log('Subject expansion complete');
                            clearTimeout(failsafeTimeout);
                            restoreTransitions();
                            resolve();
                        }, 300); // Reduced from 1500ms to 300ms
                    } else {
                        // Even if grades increased, let's check what selectors work best
                        console.log('=== POST-EXPANSION GRADE ANALYSIS ===');
                        const postExpansionSelectors = [
                            'tr[class*="grade"]',
                            'tr[class*="assignment"]',
                            'tr[class*="item"]',
                            '.grade-item',
                            '.assignment-item',
                            'tr.report-row',
                            'tr[data-id]'
                        ];

                        postExpansionSelectors.forEach(selector => {
                            const elements = document.querySelectorAll(selector);
                            console.log(`Post-expansion ${selector}: ${elements.length} elements`);
                        });

                        console.log('Subject expansion complete');
                        clearTimeout(failsafeTimeout);
                        restoreTransitions();
                        resolve();
                    }
                }, 200); // Reduced from 1000ms to 200ms
            });
        }

        /**
         * Parse a single grade row element
         * @param {Element} row - The DOM element containing grade data
         * @returns {Object|null} Grade data object or null if parsing fails
         */
        parseGradeRow(row) {
            try {
                const assignmentName = this.extractAssignmentName(row);
                const gradeValue = this.extractGradeValue(row);
                const subject = this.extractSubject(row);
                const maxPoints = this.extractMaxPoints(row);
                const category = this.extractCategory(row);
                const markingPeriod = this.extractMarkingPeriodForRow(row);
                const status = this.extractAssignmentStatus(row);

                // Debug: Log what we found for each row
                console.log('parseGradeRow debug:', {
                    assignmentName: assignmentName,
                    gradeValue: gradeValue,
                    subject: subject,
                    markingPeriod: markingPeriod,
                    status: status,
                    rowClasses: row.className,
                    rowId: row.getAttribute('data-id')
                });

                // Only return if we have essential data
                if (!assignmentName && !gradeValue) {
                    console.log('parseGradeRow: Skipping row - no assignment name or grade value');
                    return null;
                }

                return {
                    subject: subject || 'Unknown Subject',
                    assignmentName: assignmentName || 'Unknown Assignment',
                    grade: gradeValue,
                    maxPoints: maxPoints,
                    category: category || 'General',
                    markingPeriod: markingPeriod || 'current',
                    status: status,
                    extractedFrom: row.outerHTML.substring(0, 200) + '...' // For debugging
                };
            } catch (error) {
                console.warn('DataExtractor: Error parsing grade row:', error);
                // Create a more specific error for grade extraction
                const extractionError = new Error(`Failed to extract grade data from row: ${error.message}`);
                extractionError.originalError = error;
                extractionError.context = 'gradeExtraction';
                throw extractionError;
            }
        }

        /**
         * Extract assignment name from a grade row
         * @param {Element} row - The grade row element
         * @returns {string|null} Assignment name or null
         */
        extractAssignmentName(row) {
            const nameSelectors = [
                '.assignment-name',
                '.grade-item-name',
                '.title-column .title',  // Parent page specific
                '.title-column',         // Parent page specific
                'th .title',            // Parent page specific
                'td:first-child',
                '.item-title',
                'a[href*="assignment"]',
                '.assignment-title',
                '.td-content-wrapper .title'  // Parent page specific
            ];

            for (const selector of nameSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    let text = element.textContent.trim();
                    if (text && text.length > 0) {
                        // Clean up parent page assignment names
                        text = this.cleanAssignmentName(text);
                        if (text && text.length > 0) {
                            return text;
                        }
                    }
                }
            }

            return null;
        }

        /**
         * Clean up assignment name by removing common Schoology parent page artifacts
         * @param {string} rawName - Raw assignment name text
         * @returns {string} Cleaned assignment name
         */
        cleanAssignmentName(rawName) {
            if (!rawName) return '';

            let cleaned = rawName;

            // Remove common Schoology parent page artifacts
            cleaned = cleaned.replace(/Note: This material is not available within Schoology/gi, '');
            cleaned = cleaned.replace(/Due \d{1,2}\/\d{1,2}\/\d{2,4}.*$/gi, ''); // Remove due dates
            cleaned = cleaned.replace(/\s*\d{1,2}:\d{2}[ap]m\s*/gi, ''); // Remove times
            cleaned = cleaned.replace(/\s+/g, ' '); // Normalize whitespace
            cleaned = cleaned.trim();

            // Remove empty parentheses or brackets
            cleaned = cleaned.replace(/\(\s*\)/g, '');
            cleaned = cleaned.replace(/\[\s*\]/g, '');
            cleaned = cleaned.replace(/\{\s*\}/g, '');

            return cleaned;
        }

        /**
         * Extract grade value from a grade row
         * @param {Element} row - The grade row element
         * @returns {string|number|null} Grade value or null
         */
        extractGradeValue(row) {
            // First check for missing assignment indicators in the entire row
            const rowText = row.textContent.toLowerCase();
            // Check for absent assignments first (should be excused, not missing)
            if (rowText.includes('absent')) {
                console.log('Grade extraction - found absent indicator in row text, treating as excused');
                return 'Excused';
            }

            if (rowText.includes('missing') || rowText.includes('📋 missing') ||
                rowText.includes('not submitted')) {
                console.log('Grade extraction - found missing indicator in row text');

                // Check if this missing assignment has been submitted (waiting for grading)
                const fullRowText = row.textContent; // Keep original case for emoji detection
                const hasSubmissionIndicator = fullRowText.includes('📄') ||
                    fullRowText.includes('This student has made a submission that has not been graded');

                if (hasSubmissionIndicator) {
                    console.log('Grade extraction - missing assignment has submission indicator, marking as waiting');
                    return 'WaitingForGrading';
                } else {
                    console.log('Grade extraction - missing assignment has no submission indicator, marking as missing');
                    return 'Missing';
                }
            }

            const gradeSelectors = [
                '.grade-column',
                '.grade-value',
                'td[class*="grade"]',
                '.score',
                '.points-earned',
                'td:last-child',
                '.grade-display',
                // Parent page specific selectors
                'td.grade-cell',
                'td[data-grade]',
                '.grade-wrapper',
                'td:nth-last-child(1)',  // Often the last column
                'td:nth-last-child(2)',   // Sometimes second to last
                // Based on console output, grades are in cells
                'td',  // Check all td elements
                'th'   // Check all th elements too
            ];

            for (const selector of gradeSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    const text = element.textContent.trim();
                    console.log(`Grade extraction - selector: ${selector}, text: "${text}"`);
                    const grade = this.parseGradeValue(text);
                    console.log(`Grade extraction - parsed grade:`, grade);
                    if (grade !== null) {
                        return grade;
                    }
                }
            }

            return null;
        }

        /**
         * Parse grade value from text content
         * @param {string} text - Raw text containing grade
         * @returns {string|number|null} Parsed grade value
         */
        parseGradeValue(text) {
            if (!text || text.length === 0) {
                return null;
            }

            // Clean up the text
            text = text.trim().replace(/\s+/g, ' ');

            // Skip empty or placeholder values
            if (text === '-' || text === 'N/A' || text === '--' || text === '' ||
                text === '—Exempt' || text.toLowerCase().includes('exempt')) {
                return null;
            }

            // Check for missing assignment indicators
            if (text.toLowerCase().includes('missing') ||
                text.toLowerCase().includes('not submitted') ||
                text.toLowerCase().includes('absent') ||
                text === 'M' || text === 'm') {
                return 'Missing';
            }

            // Letter grade with points format (A 3 / 3, B 8.5 / 10, B 81.67 / 100)
            // Also handle cases with extra text like "A 5 / 5This student has completed..."
            const letterPointsMatch = text.match(/^([A-F][+-]?)\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
            if (letterPointsMatch) {
                const letter = letterPointsMatch[1].toUpperCase();
                const earned = parseFloat(letterPointsMatch[2]);
                const total = parseFloat(letterPointsMatch[3]);
                return {
                    letter: letter,
                    earned: earned,
                    total: total,
                    percentage: total > 0 ? (earned / total) * 100 : 0
                };
            }

            // Letter grades (A, B+, C-, etc.)
            const letterGradeMatch = text.match(/^([A-F][+-]?)$/i);
            if (letterGradeMatch) {
                return letterGradeMatch[1].toUpperCase();
            }

            // Percentage grades (85%, 92.5%)
            const percentageMatch = text.match(/(\d+(?:\.\d+)?)%/);
            if (percentageMatch) {
                return parseFloat(percentageMatch[1]);
            }

            // Points format (85/100, 17.5/20, 85 / 100 with spaces)
            const pointsMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
            if (pointsMatch) {
                const earned = parseFloat(pointsMatch[1]);
                const total = parseFloat(pointsMatch[2]);
                return {
                    earned: earned,
                    total: total,
                    percentage: total > 0 ? (earned / total) * 100 : 0
                };
            }

            // Simple numeric grade
            const numericMatch = text.match(/^(\d+(?:\.\d+)?)$/);
            if (numericMatch) {
                return parseFloat(numericMatch[1]);
            }

            return null;
        }

        /**
         * Extract subject/course name
         * @param {Element} row - The grade row element
         * @returns {string|null} Subject name or null
         */
        extractSubject(row) {
            // First try to find subject within the row
            const rowSubjectSelectors = [
                '.course-name',
                '.subject',
                '.class-name'
            ];

            for (const selector of rowSubjectSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    const text = element.textContent.trim();
                    if (text && text.length > 0) {
                        return text;
                    }
                }
            }

            // New approach: Build a mapping of course sections to their assignments
            // This is more reliable than trying to walk the DOM
            const subject = this.findSubjectForRow(row);
            if (subject) {
                return subject;
            }

            // If still not found, look for page-level subject (fallback)
            for (const selector of this.subjectSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    const text = element.textContent.trim();
                    if (text && text.length > 0 && !text.includes('Grade') && !text.includes('Report')) {
                        return text;
                    }
                }
            }

            return null;
        }

        /**
         * Find the correct subject/course for a given assignment row
         * by analyzing the document structure and course sections
         */
        findSubjectForRow(row) {
            // Strategy 1: Look for course title in the same container/section
            let currentElement = row;
            while (currentElement && currentElement.parentElement) {
                // Check if this element or its siblings contain a course title
                const container = currentElement.parentElement;
                const courseTitle = container.querySelector('.gradebook-course-title');
                if (courseTitle) {
                    const courseText = courseTitle.textContent.trim();
                    if (courseText && courseText.length > 0) {
                        return courseText;
                    }
                }
                currentElement = currentElement.parentElement;
            }

            // Strategy 2: Look for the closest preceding course title in document order
            const allElements = document.querySelectorAll('*');
            const allElementsArray = Array.from(allElements);
            const targetIndex = allElementsArray.indexOf(row);

            if (targetIndex >= 0) {
                // Look backwards for course titles
                for (let i = targetIndex - 1; i >= 0; i--) {
                    const element = allElementsArray[i];
                    if (element.classList.contains('gradebook-course-title') ||
                        element.querySelector('.gradebook-course-title')) {
                        const courseTitle = element.classList.contains('gradebook-course-title') ?
                            element : element.querySelector('.gradebook-course-title');
                        const courseText = courseTitle.textContent.trim();
                        if (courseText && courseText.length > 0) {
                            return courseText;
                        }
                    }
                }
            }

            // Strategy 3: Look at URL or page context for course information
            const urlMatch = window.location.href.match(/course\/(\d+)/);
            if (urlMatch) {
                // Try to find course name in page title or headers
                const pageTitle = document.title;
                const h1Elements = document.querySelectorAll('h1');
                for (const h1 of h1Elements) {
                    const text = h1.textContent.trim();
                    if (text.includes('Hon') || text.includes('Sec') || text.includes('PER')) {
                        return text;
                    }
                }
            }

            // Alternative: Look for course headers that precede this row
            const rowPosition = this.getElementPosition(row);
            let closestCourse = null;
            let closestDistance = Infinity;

            courseTitles.forEach(courseTitle => {
                const coursePosition = this.getElementPosition(courseTitle);

                // Only consider courses that appear before this row in the document
                if (coursePosition < rowPosition) {
                    const distance = rowPosition - coursePosition;
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        closestCourse = courseTitle.textContent.trim();
                    }
                }
            });

            return closestCourse;
        }

        /**
         * Get a rough position indicator for an element in the document
         * Used to determine document order
         */
        getElementPosition(element) {
            let position = 0;
            let current = element;

            while (current) {
                if (current.previousElementSibling) {
                    position++;
                    current = current.previousElementSibling;
                } else {
                    current = current.parentElement;
                    if (current) {
                        position += 1000; // Weight parent changes heavily
                    }
                }
            }

            return position;
        }

        /**
         * Extract marking period context for a specific grade row
         * @param {Element} row - The grade row element
         * @returns {string} Marking period ('MP1', 'MP2', 'MP3', 'MP4', 'Final', or 'current')
         */
        extractMarkingPeriodForRow(row) {
            // Strategy 1: Look for MP headers that precede this row in the document
            const allRows = document.querySelectorAll('tr, .gradebook-course-title, h1, h2, h3, .period-header');
            const allRowsArray = Array.from(allRows);
            const currentRowIndex = allRowsArray.indexOf(row);

            if (currentRowIndex >= 0) {
                // Look backwards through the document to find the most recent MP header
                for (let i = currentRowIndex; i >= 0; i--) {
                    const element = allRowsArray[i];
                    const text = element.textContent || '';

                    // Look for MP patterns like "MP 1 2025-2026", "MP1", "Marking Period 1", etc.
                    const mpMatch = text.match(/MP\s*(\d+)|Marking\s*Period\s*(\d+)|Quarter\s*(\d+)/i);
                    if (mpMatch) {
                        const mpNumber = mpMatch[1] || mpMatch[2] || mpMatch[3];
                        return `MP${mpNumber}`;
                    }

                    // Look for Final exam period
                    if (text.match(/Final\s*Exam|Final\s*Grade|Final\s*Period/i)) {
                        return 'Final';
                    }
                }
            }

            // Strategy 2: Look for MP context in parent elements
            let currentElement = row;
            while (currentElement && currentElement !== document.body) {
                // Check siblings and parent elements for MP indicators
                const siblings = currentElement.parentElement ? Array.from(currentElement.parentElement.children) : [];
                const currentIndex = siblings.indexOf(currentElement);

                // Look at preceding siblings
                for (let i = currentIndex - 1; i >= 0; i--) {
                    const sibling = siblings[i];
                    const text = sibling.textContent || '';

                    const mpMatch = text.match(/MP\s*(\d+)|Marking\s*Period\s*(\d+)/i);
                    if (mpMatch) {
                        const mpNumber = mpMatch[1] || mpMatch[2];
                        return `MP${mpNumber}`;
                    }

                    if (text.match(/Final\s*Exam|Final\s*Grade|Final\s*Period/i)) {
                        return 'Final';
                    }
                }

                currentElement = currentElement.parentElement;
            }

            // Strategy 3: Check if we're in a specific course section that might have MP context
            const courseSection = row.closest('.gradebook-course, .course-section, table');
            if (courseSection) {
                const courseSectionText = courseSection.textContent || '';
                const mpMatch = courseSectionText.match(/MP\s*(\d+)|Marking\s*Period\s*(\d+)/i);
                if (mpMatch) {
                    const mpNumber = mpMatch[1] || mpMatch[2];
                    return `MP${mpNumber}`;
                }

                if (courseSectionText.match(/Final\s*Exam|Final\s*Grade|Final\s*Period/i)) {
                    return 'Final';
                }
            }

            // Default: return 'current' if no specific marking period detected
            return 'current';
        }

        /**
         * Filter grades by marking period
         * @param {Array} grades - Array of grade objects
         * @param {string} markingPeriod - Target marking period ('MP1', 'MP2', 'MP3', 'MP4', 'Final', 'current')
         * @returns {Array} Filtered grades for the specified marking period
         */
        filterGradesByMarkingPeriod(grades, markingPeriod) {
            if (!markingPeriod || markingPeriod === 'current') {
                return grades; // Return all grades if no specific period or 'current'
            }

            console.log(`Filtering ${grades.length} grades for marking period: ${markingPeriod}`);

            const filtered = grades.filter(grade => {
                const gradeMP = grade.markingPeriod || 'current';
                const matches = gradeMP === markingPeriod;

                if (!matches) {
                    console.log(`Excluding grade: ${grade.assignmentName} (${grade.subject}) - MP: ${gradeMP}`);
                }

                return matches;
            });

            console.log(`Filtered result: ${filtered.length} grades for ${markingPeriod}`);
            return filtered;
        }

        /**
         * Extract maximum points for an assignment
         * @param {Element} row - The grade row element
         * @returns {number|null} Maximum points or null
         */
        extractMaxPoints(row) {
            const pointsSelectors = [
                '.max-points',
                '.total-points',
                'td[class*="points"]'
            ];

            for (const selector of pointsSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    const text = element.textContent.trim();
                    const match = text.match(/(\d+(?:\.\d+)?)/);
                    if (match) {
                        return parseFloat(match[1]);
                    }
                }
            }

            // Try to extract from grade value if it's in points format
            const gradeElement = row.querySelector('.grade-column, .grade-value, td[class*="grade"]');
            if (gradeElement) {
                const text = gradeElement.textContent.trim();
                const pointsMatch = text.match(/\d+(?:\.\d+)?\/(\d+(?:\.\d+)?)/);
                if (pointsMatch) {
                    return parseFloat(pointsMatch[1]);
                }
            }

            return null;
        }

        /**
         * Extract assignment category
         * @param {Element} row - The grade row element
         * @returns {string|null} Category name or null
         */
        extractCategory(row) {
            // First try standard category selectors
            const categorySelectors = [
                '.category',
                '.assignment-category',
                '.grade-category',
                'td[class*="category"]'
            ];

            for (const selector of categorySelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    const text = element.textContent.trim();
                    if (text && text.length > 0) {
                        return text;
                    }
                }
            }

            // If no direct category found, look for section context by finding the nearest section header
            let currentElement = row;
            let attempts = 0;
            const maxAttempts = 20; // Prevent infinite loops

            while (currentElement && attempts < maxAttempts) {
                currentElement = currentElement.previousElementSibling;
                attempts++;

                if (currentElement) {
                    const text = currentElement.textContent;
                    if (text) {
                        // Look for section headers like "Practice", "Major", "Minor"
                        if (text.includes('Practice')) {
                            console.log(`Found Practice section context for assignment in row`);
                            return 'Practice';
                        }
                        if (text.includes('Major')) {
                            console.log(`Found Major section context for assignment in row`);
                            return 'Major';
                        }
                        if (text.includes('Minor')) {
                            console.log(`Found Minor section context for assignment in row`);
                            return 'Minor';
                        }
                    }
                }
            }

            console.log(`No category found for assignment row, defaulting to General`);
            return 'General';
        }

        /**
         * Extract all assignments with their status and due dates
         * @returns {Array} Array of assignment objects
         */
        extractAssignments() {
            const assignments = [];

            // Use the same selectors that work for grade extraction since assignments and grades are in the same rows
            for (const selector of this.gradeSelectors) {
                const rows = document.querySelectorAll(selector);
                if (rows.length > 0) {
                    console.log(`DataExtractor: Found ${rows.length} assignment rows using selector: ${selector}`);

                    rows.forEach(row => {
                        const assignmentData = this.parseAssignmentRow(row);
                        if (assignmentData) {
                            assignments.push(assignmentData);
                        }
                    });

                    if (assignments.length > 0) {
                        break; // Use first successful selector strategy
                    }
                }
            }

            console.log(`DataExtractor: Extracted ${assignments.length} assignment entries`);
            return assignments;
        }

        /**
         * Parse a single assignment row element
         * @param {Element} row - The DOM element containing assignment data
         * @returns {Object|null} Assignment data object or null if parsing fails
         */
        parseAssignmentRow(row) {
            try {
                const name = this.extractAssignmentName(row);
                const dueDate = this.extractDueDate(row);
                const status = this.extractAssignmentStatus(row);
                const subject = this.extractSubject(row);
                const pointValue = this.extractMaxPoints(row);
                const category = this.categorizeAssignment(name, this.extractCategory(row));

                // Debug: Log what we found for each assignment row
                console.log('parseAssignmentRow debug:', {
                    name: name,
                    dueDate: dueDate,
                    status: status,
                    subject: subject,
                    rowClasses: row.className
                });

                // Only return if we have essential data
                if (!name) {
                    console.log('parseAssignmentRow: Skipping row - no assignment name');
                    return null;
                }

                // Filter out exempt assignments
                const rowText = row.textContent || '';
                if (rowText.toLowerCase().includes('exempt') ||
                    (name && name.toLowerCase().includes('exempt')) ||
                    (status && status.toLowerCase().includes('exempt')) ||
                    (status && status.toLowerCase().includes('excused'))) {
                    console.log('parseAssignmentRow: Skipping exempt/excused assignment:', name, 'Status:', status);
                    return null;
                }

                // Calculate due date status
                const dueDateStatus = this.calculateDueDateStatus(dueDate);

                // Determine if this is a major assignment
                const isMajor = this.isMajorAssignment(name, pointValue, category);

                return {
                    subject: subject || 'Unknown Subject',
                    name: name,
                    dueDate: dueDate,
                    status: status || 'unknown',
                    pointValue: pointValue || 0,
                    category: category || 'General',
                    daysUntilDue: dueDateStatus.daysUntilDue,
                    daysOverdue: dueDateStatus.daysOverdue,
                    dueDateStatus: dueDateStatus.status,
                    isMajor: isMajor,
                    extractedFrom: row.outerHTML.substring(0, 200) + '...' // For debugging
                };
            } catch (error) {
                console.warn('DataExtractor: Error parsing assignment row:', error);
                // Create a more specific error for assignment extraction
                const extractionError = new Error(`Failed to extract assignment data from row: ${error.message}`);
                extractionError.originalError = error;
                extractionError.context = 'assignmentExtraction';
                throw extractionError;
            }
        }

        /**
         * Extract due date from assignment row
         * @param {Element} row - The assignment row element
         * @returns {Date|null} Due date or null
         */
        extractDueDate(row) {
            const dueDateSelectors = [
                '.due-date',
                '.assignment-due-date',
                'td[class*="due"]',
                '.date-due',
                'time[datetime]',
                '.deadline'
            ];

            for (const selector of dueDateSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    // Try datetime attribute first
                    const datetime = element.getAttribute('datetime');
                    if (datetime) {
                        const date = new Date(datetime);
                        if (!isNaN(date.getTime())) {
                            return date;
                        }
                    }

                    // Parse text content
                    const text = element.textContent.trim();
                    const parsedDate = this.parseDateString(text);
                    if (parsedDate) {
                        return parsedDate;
                    }
                }
            }

            // Look for date patterns in any cell
            const cells = row.querySelectorAll('td, .cell');
            for (const cell of cells) {
                const text = cell.textContent.trim();
                const parsedDate = this.parseDateString(text);
                if (parsedDate) {
                    return parsedDate;
                }
            }

            // Look for due dates in assignment names (common in Schoology)
            const assignmentName = this.extractAssignmentName(row);
            if (assignmentName) {
                const dueDateMatch = assignmentName.match(/Due\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
                if (dueDateMatch) {
                    const parsedDate = this.parseDateString(dueDateMatch[1]);
                    if (parsedDate) {
                        return parsedDate;
                    }
                }
            }

            return null;
        }

        /**
         * Parse date string in various Schoology formats
         * @param {string} dateStr - Date string to parse
         * @returns {Date|null} Parsed date or null
         */
        parseDateString(dateStr) {
            if (!dateStr || dateStr.length === 0) {
                return null;
            }

            // Clean up the string
            dateStr = dateStr.trim().replace(/\s+/g, ' ');

            // Skip non-date content
            if (dateStr === '-' || dateStr === 'N/A' || dateStr === '--' || dateStr.length < 6) {
                return null;
            }

            // Remove common prefixes and suffixes
            dateStr = dateStr.replace(/^(due:?|deadline:?|on:?)\s*/i, '');
            dateStr = dateStr.replace(/\s*(at|@)\s*\d{1,2}:\d{2}.*$/i, ''); // Remove time portion

            // Common date formats in Schoology
            const dateFormats = [
                // MM/DD/YYYY or MM/DD/YY
                {
                    regex: /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
                    parser: (match) => {
                        let year = parseInt(match[3]);
                        if (year < 100) {
                            year += year < 50 ? 2000 : 1900; // Handle 2-digit years
                        }
                        return new Date(year, parseInt(match[1]) - 1, parseInt(match[2]));
                    }
                },
                // MM-DD-YYYY or MM-DD-YY
                {
                    regex: /(\d{1,2})-(\d{1,2})-(\d{2,4})/,
                    parser: (match) => {
                        let year = parseInt(match[3]);
                        if (year < 100) {
                            year += year < 50 ? 2000 : 1900;
                        }
                        return new Date(year, parseInt(match[1]) - 1, parseInt(match[2]));
                    }
                },
                // YYYY-MM-DD (ISO format)
                {
                    regex: /(\d{4})-(\d{1,2})-(\d{1,2})/,
                    parser: (match) => {
                        return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
                    }
                },
                // Month DD, YYYY (e.g., "March 15, 2024")
                {
                    regex: /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i,
                    parser: (match) => {
                        return new Date(`${match[1]} ${match[2]}, ${match[3]}`);
                    }
                },
                // DD Month YYYY (e.g., "15 March 2024")
                {
                    regex: /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i,
                    parser: (match) => {
                        return new Date(`${match[2]} ${match[1]}, ${match[3]}`);
                    }
                },
                // Month DD (current year assumed)
                {
                    regex: /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i,
                    parser: (match) => {
                        const currentYear = new Date().getFullYear();
                        return new Date(`${match[1]} ${match[2]}, ${currentYear}`);
                    }
                },
                // DD/MM format (assume current year)
                {
                    regex: /^(\d{1,2})\/(\d{1,2})$/,
                    parser: (match) => {
                        const currentYear = new Date().getFullYear();
                        // Assume MM/DD format for US-based Schoology
                        return new Date(currentYear, parseInt(match[1]) - 1, parseInt(match[2]));
                    }
                },
                // Relative dates
                {
                    regex: /today/i,
                    parser: () => new Date()
                },
                {
                    regex: /tomorrow/i,
                    parser: () => {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        return tomorrow;
                    }
                },
                {
                    regex: /yesterday/i,
                    parser: () => {
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        return yesterday;
                    }
                },
                // "in X days" format
                {
                    regex: /in\s+(\d+)\s+days?/i,
                    parser: (match) => {
                        const future = new Date();
                        future.setDate(future.getDate() + parseInt(match[1]));
                        return future;
                    }
                },
                // "X days ago" format
                {
                    regex: /(\d+)\s+days?\s+ago/i,
                    parser: (match) => {
                        const past = new Date();
                        past.setDate(past.getDate() - parseInt(match[1]));
                        return past;
                    }
                }
            ];

            // Try each format
            for (const format of dateFormats) {
                const match = dateStr.match(format.regex);
                if (match) {
                    try {
                        const date = format.parser(match);
                        if (date && !isNaN(date.getTime())) {
                            // Normalize to start of day to avoid time zone issues
                            date.setHours(0, 0, 0, 0);
                            return date;
                        }
                    } catch (error) {
                        console.warn('Date parsing error:', error);
                        continue;
                    }
                }
            }

            // Try native Date parsing as fallback
            try {
                const nativeDate = new Date(dateStr);
                if (!isNaN(nativeDate.getTime())) {
                    nativeDate.setHours(0, 0, 0, 0);
                    return nativeDate;
                }
            } catch (error) {
                console.warn('Native date parsing failed:', error);
            }

            return null;
        }

        /**
         * Extract assignment status (missing, submitted, graded)
         * @param {Element} row - The assignment row element
         * @returns {string} Assignment status
         */
        extractAssignmentStatus(row) {
            const statusSelectors = [
                '.status',
                '.assignment-status',
                'td[class*="status"]',
                '.submission-status',
                '.grade-status',
                '[data-status]'
            ];

            // First, check the entire row text for "Absent" since it might not be in a specific status element
            const rowText = row.textContent.toLowerCase();
            if (rowText.includes('absent')) {
                console.log(`extractAssignmentStatus: Found "absent" in row text, returning excused`);
                return 'excused';
            }

            // Check for explicit status indicators
            for (const selector of statusSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    const text = element.textContent.trim().toLowerCase();
                    console.log(`extractAssignmentStatus: Checking selector "${selector}", found text: "${text}"`);

                    // Missing assignment indicators
                    if (text.includes('missing') ||
                        text.includes('not submitted') ||
                        text.includes('overdue') ||
                        text.includes('late') ||
                        text === 'm' || text === 'miss') {
                        console.log(`extractAssignmentStatus: Returning "missing" for text: "${text}"`);
                        return 'missing';
                    }

                    // Submitted but not graded indicators
                    if (text.includes('submitted') ||
                        text.includes('turned in') ||
                        text.includes('pending') ||
                        text.includes('awaiting') ||
                        text === 's' || text === 'sub') {
                        console.log(`extractAssignmentStatus: Returning "submitted" for text: "${text}"`);
                        return 'submitted';
                    }

                    // Graded indicators
                    if (text.includes('graded') ||
                        text.includes('scored') ||
                        text.includes('complete') ||
                        text.includes('finished') ||
                        text === 'g' || text === 'done') {
                        console.log(`extractAssignmentStatus: Returning "graded" for text: "${text}"`);
                        return 'graded';
                    }

                    // Excused indicators
                    if (text.includes('excused') ||
                        text.includes('exempt') ||
                        text.includes('absent') ||
                        text === 'e' || text === 'exc' || text === 'abs') {
                        console.log(`extractAssignmentStatus: Returning "excused" for text: "${text}"`);
                        return 'excused';
                    }
                }
            }

            // Check for visual indicators (icons, colors, etc.)
            const visualIndicators = [
                '.missing-icon',
                '.late-icon',
                '.submitted-icon',
                '.graded-icon',
                '.status-missing',
                '.status-late',
                '.status-submitted',
                '.status-graded'
            ];

            for (const selector of visualIndicators) {
                const element = row.querySelector(selector);
                if (element) {
                    const className = element.className.toLowerCase();
                    if (className.includes('missing') || className.includes('late')) {
                        return 'missing';
                    }
                    if (className.includes('submitted')) {
                        return 'submitted';
                    }
                    if (className.includes('graded')) {
                        return 'graded';
                    }
                }
            }

            // Infer status from grade value and due date
            const gradeValue = this.extractGradeValue(row);
            const dueDate = this.extractDueDate(row);
            const currentDate = new Date();

            // If there's a grade value, it's been graded
            if (gradeValue !== null && gradeValue !== '-' && gradeValue !== 'N/A' && gradeValue !== '') {
                return 'graded';
            }

            // If no grade and past due date, it's missing
            if (dueDate && dueDate < currentDate) {
                const daysPastDue = Math.floor((currentDate - dueDate) / (1000 * 60 * 60 * 24));
                // Give a grace period of 1 day for late submissions
                if (daysPastDue > 1) {
                    return 'missing';
                }
                return 'submitted'; // Might be submitted but not graded yet
            }

            // If due date is in the future and no grade, it's not submitted yet
            if (dueDate && dueDate > currentDate) {
                return 'not_submitted';
            }

            // Default case - no clear indicators
            return 'unknown';
        }

        /**
         * Categorize assignment based on name and explicit category
         * @param {string} assignmentName - Name of the assignment
         * @param {string} explicitCategory - Explicit category if available
         * @returns {string} Assignment category
         */
        categorizeAssignment(assignmentName, explicitCategory) {
            // Use explicit category if available and meaningful
            if (explicitCategory && explicitCategory.trim() &&
                explicitCategory.toLowerCase() !== 'general' &&
                explicitCategory.toLowerCase() !== 'assignment') {
                return explicitCategory;
            }

            if (!assignmentName) {
                return 'General';
            }

            const name = assignmentName.toLowerCase();

            // Test/Exam/Quiz keywords (highest priority for academic importance)
            const testKeywords = [
                'test', 'exam', 'quiz', 'midterm', 'final', 'assessment',
                'evaluation', 'checkpoint', 'unit test', 'chapter test',
                'pop quiz', 'surprise quiz', 'mock exam', 'practice test'
            ];

            if (testKeywords.some(keyword => name.includes(keyword))) {
                // Further categorize tests
                if (name.includes('quiz') || name.includes('pop quiz')) {
                    return 'Quiz';
                }
                if (name.includes('midterm') || name.includes('final')) {
                    return 'Exam';
                }
                return 'Test';
            }

            // Project keywords (major assignments)
            const projectKeywords = [
                'project', 'presentation', 'report', 'essay', 'paper',
                'research', 'thesis', 'portfolio', 'capstone', 'investigation',
                'analysis', 'study', 'review', 'proposal', 'design',
                'creative', 'artwork', 'performance', 'demonstration'
            ];

            if (projectKeywords.some(keyword => name.includes(keyword))) {
                // Further categorize projects
                if (name.includes('presentation') || name.includes('demo')) {
                    return 'Presentation';
                }
                if (name.includes('essay') || name.includes('paper') || name.includes('report')) {
                    return 'Essay/Report';
                }
                if (name.includes('research') || name.includes('investigation')) {
                    return 'Research Project';
                }
                return 'Project';
            }

            // Lab/Practical work keywords
            const labKeywords = [
                'lab', 'laboratory', 'experiment', 'practical', 'fieldwork',
                'observation', 'simulation', 'hands-on', 'workshop',
                'activity', 'investigation', 'exploration'
            ];

            if (labKeywords.some(keyword => name.includes(keyword))) {
                return 'Lab';
            }

            // Homework/Practice keywords
            const homeworkKeywords = [
                'homework', 'hw', 'assignment', 'practice', 'exercise',
                'drill', 'worksheet', 'problem set', 'study guide',
                'review', 'preparation', 'reading', 'journal', 'log',
                'daily work', 'classwork', 'warm-up', 'bell ringer'
            ];

            if (homeworkKeywords.some(keyword => name.includes(keyword))) {
                // Further categorize homework
                if (name.includes('reading') || name.includes('journal')) {
                    return 'Reading/Journal';
                }
                if (name.includes('practice') || name.includes('drill') || name.includes('exercise')) {
                    return 'Practice';
                }
                return 'Homework';
            }

            // Discussion/Participation keywords
            const discussionKeywords = [
                'discussion', 'forum', 'participation', 'contribution',
                'comment', 'response', 'reflection', 'blog', 'post',
                'peer review', 'feedback', 'collaboration'
            ];

            if (discussionKeywords.some(keyword => name.includes(keyword))) {
                return 'Discussion';
            }

            // Extra Credit keywords
            const extraCreditKeywords = [
                'extra credit', 'bonus', 'optional', 'supplemental',
                'additional', 'enrichment'
            ];

            if (extraCreditKeywords.some(keyword => name.includes(keyword))) {
                return 'Extra Credit';
            }

            // Check for numeric patterns that might indicate type
            if (/\b(chapter|unit|lesson)\s*\d+/i.test(name)) {
                return 'Chapter/Unit Work';
            }

            if (/\b(week|day)\s*\d+/i.test(name)) {
                return 'Daily/Weekly Work';
            }

            // Default category
            return 'General';
        }

        /**
         * Extract all teacher comments from the page
         * @returns {Array} Array of comment objects
         */
        extractComments() {
            const comments = [];

            // Try different selector strategies for comments
            const commentSelectors = [
                '.teacher-comment',
                '.comment',
                '.feedback',
                '.instructor-comment',
                'td[class*="comment"]',
                '.grade-comment',
                '[data-comment]'
            ];

            // Look for comments in grade rows
            const rows = document.querySelectorAll('.gradebook-table tbody tr, .grade-item, table[class*="grade"] tbody tr');

            rows.forEach(row => {
                const commentData = this.parseCommentFromRow(row);
                if (commentData) {
                    comments.push(commentData);
                }
            });

            // Also look for standalone comment sections
            for (const selector of commentSelectors) {
                const elements = document.querySelectorAll(selector);
                elements.forEach(element => {
                    const commentData = this.parseCommentElement(element);
                    if (commentData) {
                        // Avoid duplicates
                        const isDuplicate = comments.some(existing =>
                            existing.comment === commentData.comment &&
                            existing.assignmentName === commentData.assignmentName
                        );
                        if (!isDuplicate) {
                            comments.push(commentData);
                        }
                    }
                });
            }

            console.log(`DataExtractor: Extracted ${comments.length} teacher comments`);
            return comments;
        }

        /**
         * Parse teacher comment from a grade row
         * @param {Element} row - The grade row element
         * @returns {Object|null} Comment data object or null
         */
        parseCommentFromRow(row) {
            const commentSelectors = [
                '.teacher-comment',
                '.comment',
                '.feedback',
                '.instructor-comment',
                'td[class*="comment"]',
                '.grade-comment',
                '.assignment-feedback',
                '.teacher-feedback',
                '[data-comment]'
            ];

            for (const selector of commentSelectors) {
                const element = row.querySelector(selector);
                if (element) {
                    const commentText = this.extractCommentText(element);
                    if (commentText && commentText.length > 0) {
                        // Enhanced assignment association
                        const assignmentName = this.extractAssignmentName(row);
                        const subject = this.extractSubject(row);

                        // Validate that we have meaningful assignment association
                        if (!assignmentName || assignmentName === 'Unknown Assignment') {
                            // Try to find assignment context in nearby elements
                            const contextAssignment = this.findAssignmentContext(element);
                            if (!contextAssignment) {
                                console.warn('DataExtractor: Found comment but could not associate with assignment:', commentText.substring(0, 50));
                            }
                        }

                        const cleanedAssignmentName = assignmentName ? this.cleanAssignmentName(assignmentName) : null;

                        return {
                            subject: subject || 'Unknown Subject',
                            assignmentName: cleanedAssignmentName || 'Unknown Assignment',
                            comment: commentText,
                            teacher: this.extractTeacherName(element, row),
                            date: this.extractCommentDate(element, row),
                            commentLength: commentText.length,
                            isLongComment: commentText.length > 100,
                            extractedFrom: element.outerHTML.substring(0, 200) + '...' // For debugging
                        };
                    }
                }
            }

            return null;
        }

        /**
         * Find assignment context for a comment element when not in a clear row structure
         * @param {Element} commentElement - The comment element
         * @returns {string|null} Assignment name or null
         */
        findAssignmentContext(commentElement) {
            // Look in parent elements for assignment context
            let parent = commentElement.parentElement;
            let attempts = 0;

            while (parent && attempts < 5) {
                // Look for assignment name in the parent
                const assignmentSelectors = [
                    '.assignment-name',
                    '.grade-item-name',
                    '.item-title',
                    'a[href*="assignment"]',
                    '.assignment-title',
                    'h3',
                    'h4',
                    '.title'
                ];

                for (const selector of assignmentSelectors) {
                    const nameElement = parent.querySelector(selector);
                    if (nameElement) {
                        const text = nameElement.textContent.trim();
                        if (text && text.length > 0 && !text.toLowerCase().includes('comment')) {
                            return text;
                        }
                    }
                }

                parent = parent.parentElement;
                attempts++;
            }

            // Look in preceding sibling elements
            let sibling = commentElement.previousElementSibling;
            attempts = 0;

            while (sibling && attempts < 3) {
                const assignmentSelectors = [
                    '.assignment-name',
                    '.grade-item-name',
                    '.item-title'
                ];

                for (const selector of assignmentSelectors) {
                    const nameElement = sibling.querySelector(selector);
                    if (nameElement) {
                        const text = nameElement.textContent.trim();
                        if (text && text.length > 0) {
                            return text;
                        }
                    }
                }

                // Check if the sibling itself contains assignment name
                const siblingText = sibling.textContent.trim();
                if (siblingText && siblingText.length > 0 && siblingText.length < 100) {
                    // Might be an assignment name if it's not too long and doesn't look like a comment
                    if (!siblingText.toLowerCase().includes('comment') &&
                        !siblingText.toLowerCase().includes('feedback') &&
                        !siblingText.includes('.') && // Comments usually have periods
                        siblingText.split(' ').length <= 6) { // Assignment names are usually short
                        return siblingText;
                    }
                }

                sibling = sibling.previousElementSibling;
                attempts++;
            }

            return null;
        }

        /**
         * Parse teacher comment from a standalone comment element
         * @param {Element} element - The comment element
         * @returns {Object|null} Comment data object or null
         */
        parseCommentElement(element) {
            const commentText = this.extractCommentText(element);
            if (!commentText || commentText.length === 0) {
                return null;
            }

            // Try to find associated assignment by looking at parent elements
            let assignmentName = 'Unknown Assignment';
            let subject = 'Unknown Subject';

            // Look for assignment context in parent elements
            let parent = element.parentElement;
            let attempts = 0;
            while (parent && attempts < 5) {
                const nameElement = parent.querySelector('.assignment-name, .grade-item-name, .item-title');
                if (nameElement) {
                    assignmentName = nameElement.textContent.trim();
                    break;
                }
                parent = parent.parentElement;
                attempts++;
            }

            return {
                subject: subject,
                assignmentName: assignmentName,
                comment: commentText,
                teacher: this.extractTeacherName(element),
                date: this.extractCommentDate(element),
                extractedFrom: element.outerHTML.substring(0, 200) + '...' // For debugging
            };
        }

        /**
         * Extract comment text from element
         * @param {Element} element - The comment element
         * @returns {string|null} Comment text or null
         */
        extractCommentText(element) {
            if (!element) {
                return null;
            }

            // Try different approaches to get comment text
            let text = '';

            // Check for data attributes
            const dataComment = element.getAttribute('data-comment');
            if (dataComment) {
                text = dataComment;
            } else {
                // Get text content, but exclude nested elements that might contain metadata
                const clone = element.cloneNode(true);

                // Remove common metadata elements
                const metadataSelectors = [
                    '.date',
                    '.timestamp',
                    '.teacher-name',
                    '.author',
                    '.comment-meta'
                ];

                metadataSelectors.forEach(selector => {
                    const metaElements = clone.querySelectorAll(selector);
                    metaElements.forEach(el => el.remove());
                });

                text = clone.textContent || clone.innerText || '';
            }

            text = text.trim();

            // Filter out empty or placeholder comments
            if (!text || text.length === 0 || text === '-' || text === 'N/A' || text === 'No comment') {
                return null;
            }

            // Filter out very short comments that are likely not meaningful
            if (text.length < 3) {
                return null;
            }

            return text;
        }

        /**
         * Extract teacher name from comment element
         * @param {Element} element - The comment element
         * @param {Element} row - Optional parent row element
         * @returns {string|null} Teacher name or null
         */
        extractTeacherName(element, row = null) {
            const teacherSelectors = [
                '.teacher-name',
                '.instructor-name',
                '.author',
                '.comment-author',
                '.by-teacher',
                '.feedback-author',
                '.comment-by',
                '[data-teacher]',
                '[data-author]'
            ];

            // Look in the comment element first
            for (const selector of teacherSelectors) {
                const teacherElement = element.querySelector(selector);
                if (teacherElement) {
                    const name = this.parseTeacherName(teacherElement.textContent.trim());
                    if (name) {
                        return name;
                    }
                }
            }

            // Check for data attributes on the comment element itself
            const dataTeacher = element.getAttribute('data-teacher') || element.getAttribute('data-author');
            if (dataTeacher) {
                const name = this.parseTeacherName(dataTeacher);
                if (name) {
                    return name;
                }
            }

            // Look in the parent row if provided
            if (row) {
                for (const selector of teacherSelectors) {
                    const teacherElement = row.querySelector(selector);
                    if (teacherElement) {
                        const name = this.parseTeacherName(teacherElement.textContent.trim());
                        if (name) {
                            return name;
                        }
                    }
                }
            }

            // Look for teacher name in sibling elements (common in Schoology)
            let sibling = element.previousElementSibling;
            let attempts = 0;
            while (sibling && attempts < 3) {
                for (const selector of teacherSelectors) {
                    const teacherElement = sibling.querySelector(selector);
                    if (teacherElement) {
                        const name = this.parseTeacherName(teacherElement.textContent.trim());
                        if (name) {
                            return name;
                        }
                    }
                }
                sibling = sibling.previousElementSibling;
                attempts++;
            }

            // Look for teacher name in page-level elements
            const pageTeacherSelectors = [
                '.teacher-name',
                '.instructor-info .name',
                '.course-instructor',
                '.teacher-info',
                '.instructor-details .name',
                'h1 .teacher',
                'h2 .instructor'
            ];

            for (const selector of pageTeacherSelectors) {
                const teacherElement = document.querySelector(selector);
                if (teacherElement) {
                    const name = this.parseTeacherName(teacherElement.textContent.trim());
                    if (name) {
                        return name;
                    }
                }
            }

            return null;
        }

        /**
         * Parse and validate teacher name from text
         * @param {string} text - Raw text that might contain teacher name
         * @returns {string|null} Cleaned teacher name or null
         */
        parseTeacherName(text) {
            if (!text || text.length === 0) {
                return null;
            }

            // Clean up the text
            text = text.trim();

            // Filter out non-teacher content
            const excludePatterns = [
                /^(student|grade|assignment|due|score|points|percent)/i,
                /^(submitted|missing|late|complete|pending)/i,
                /^(test|quiz|homework|project|essay)/i,
                /^\d+/,  // Numbers
                /^[A-F][+-]?$/,  // Letter grades
                /^\d+%$/,  // Percentages
                /^\d+\/\d+$/  // Fractions
            ];

            for (const pattern of excludePatterns) {
                if (pattern.test(text)) {
                    return null;
                }
            }

            // Remove common prefixes
            text = text.replace(/^(by:?|from:?|teacher:?|instructor:?)\s*/i, '');

            // Must be at least 2 characters and contain at least one letter
            if (text.length < 2 || !/[a-zA-Z]/.test(text)) {
                return null;
            }

            // Should look like a name (contains letters and possibly spaces, periods, hyphens)
            if (!/^[a-zA-Z\s\.\-']+$/.test(text)) {
                return null;
            }

            // Capitalize properly
            return text.split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' ');
        }

        /**
         * Extract comment date from element
         * @param {Element} element - The comment element
         * @param {Element} row - Optional parent row element
         * @returns {Date|null} Comment date or null
         */
        extractCommentDate(element, row = null) {
            const dateSelectors = [
                '.date',
                '.timestamp',
                '.comment-date',
                '.feedback-date',
                'time[datetime]',
                '.created-date',
                '.posted-date',
                '[data-date]',
                '[data-timestamp]'
            ];

            // Look in the comment element first
            for (const selector of dateSelectors) {
                const dateElement = element.querySelector(selector);
                if (dateElement) {
                    // Try datetime attribute first
                    const datetime = dateElement.getAttribute('datetime');
                    if (datetime) {
                        const date = new Date(datetime);
                        if (!isNaN(date.getTime())) {
                            return date;
                        }
                    }

                    // Try data attributes
                    const dataDate = dateElement.getAttribute('data-date') || dateElement.getAttribute('data-timestamp');
                    if (dataDate) {
                        const date = new Date(dataDate);
                        if (!isNaN(date.getTime())) {
                            return date;
                        }
                    }

                    // Parse text content
                    const text = dateElement.textContent.trim();
                    const parsedDate = this.parseDateString(text);
                    if (parsedDate) {
                        return parsedDate;
                    }
                }
            }

            // Check for data attributes on the comment element itself
            const elementDataDate = element.getAttribute('data-date') || element.getAttribute('data-timestamp');
            if (elementDataDate) {
                const date = new Date(elementDataDate);
                if (!isNaN(date.getTime())) {
                    return date;
                }
            }

            // Look in sibling elements (common pattern in Schoology)
            let sibling = element.previousElementSibling;
            let attempts = 0;
            while (sibling && attempts < 3) {
                for (const selector of dateSelectors) {
                    const dateElement = sibling.querySelector(selector);
                    if (dateElement) {
                        const text = dateElement.textContent.trim();
                        const parsedDate = this.parseDateString(text);
                        if (parsedDate) {
                            return parsedDate;
                        }
                    }
                }
                sibling = sibling.previousElementSibling;
                attempts++;
            }

            // Look in the parent row if provided
            if (row) {
                for (const selector of dateSelectors) {
                    const dateElement = row.querySelector(selector);
                    if (dateElement) {
                        const text = dateElement.textContent.trim();
                        const parsedDate = this.parseDateString(text);
                        if (parsedDate) {
                            return parsedDate;
                        }
                    }
                }
            }

            // Look for date patterns in the comment text itself
            const commentText = element.textContent || '';
            const dateFromText = this.extractDateFromCommentText(commentText);
            if (dateFromText) {
                return dateFromText;
            }

            return null;
        }

        /**
         * Extract date from comment text using pattern matching
         * @param {string} text - Comment text that might contain date information
         * @returns {Date|null} Extracted date or null
         */
        extractDateFromCommentText(text) {
            if (!text || text.length === 0) {
                return null;
            }

            // Look for date patterns within the comment text
            const datePatterns = [
                // "Posted on March 15, 2024"
                /posted\s+on\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})/i,
                // "Updated 03/15/2024"
                /updated\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i,
                // "Added on 2024-03-15"
                /added\s+on\s+(\d{4})-(\d{1,2})-(\d{1,2})/i,
                // "March 15" (current year assumed)
                /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i
            ];

            for (const pattern of datePatterns) {
                const match = text.match(pattern);
                if (match) {
                    let dateStr = '';
                    if (pattern.source.includes('posted\\s+on')) {
                        dateStr = `${match[1]} ${match[2]}, ${match[3]}`;
                    } else if (pattern.source.includes('updated')) {
                        dateStr = `${match[1]}/${match[2]}/${match[3]}`;
                    } else if (pattern.source.includes('added\\s+on')) {
                        dateStr = `${match[1]}-${match[2]}-${match[3]}`;
                    } else {
                        const currentYear = new Date().getFullYear();
                        dateStr = `${match[1]} ${match[2]}, ${currentYear}`;
                    }

                    const parsedDate = this.parseDateString(dateStr);
                    if (parsedDate) {
                        return parsedDate;
                    }
                }
            }

            return null;
        }

        /**
         * Calculate days until due date or days overdue
         * @param {Date} dueDate - The due date
         * @returns {Object} Object with daysUntilDue, daysOverdue, and status
         */
        calculateDueDateStatus(dueDate) {
            if (!dueDate || isNaN(dueDate.getTime())) {
                return {
                    daysUntilDue: null,
                    daysOverdue: null,
                    status: 'no_due_date'
                };
            }

            const currentDate = new Date();
            currentDate.setHours(0, 0, 0, 0); // Normalize to start of day

            const dueDateNormalized = new Date(dueDate);
            dueDateNormalized.setHours(0, 0, 0, 0);

            const timeDiff = dueDateNormalized.getTime() - currentDate.getTime();
            const daysDiff = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

            if (daysDiff > 0) {
                return {
                    daysUntilDue: daysDiff,
                    daysOverdue: 0,
                    status: 'upcoming'
                };
            } else if (daysDiff === 0) {
                return {
                    daysUntilDue: 0,
                    daysOverdue: 0,
                    status: 'due_today'
                };
            } else {
                return {
                    daysUntilDue: 0,
                    daysOverdue: Math.abs(daysDiff),
                    status: 'overdue'
                };
            }
        }

        /**
         * Determine if an assignment is considered "major" based on various criteria
         * @param {string} assignmentName - Name of the assignment
         * @param {number} pointValue - Point value of the assignment
         * @param {string} category - Assignment category
         * @returns {boolean} True if assignment is considered major
         */
        isMajorAssignment(assignmentName, pointValue, category) {
            if (!assignmentName) {
                return false;
            }

            const name = assignmentName.toLowerCase();
            const cat = (category || '').toLowerCase();

            // High point value assignments (15% threshold mentioned in requirements)
            // Assuming 100 points is typical total, so 15+ points is major
            if (pointValue && pointValue >= 15) {
                return true;
            }

            // Category-based major assignment detection
            const majorCategories = [
                'test', 'exam', 'quiz', 'project', 'essay/report',
                'research project', 'presentation'
            ];

            if (majorCategories.includes(cat)) {
                return true;
            }

            // Name-based major assignment detection
            const majorKeywords = [
                'test', 'exam', 'quiz', 'project', 'essay', 'paper',
                'presentation', 'report', 'midterm', 'final',
                'research', 'thesis', 'portfolio', 'capstone'
            ];

            return majorKeywords.some(keyword => name.includes(keyword));
        }
    }

    /**
     * Storage management for user preferences and panel state
     * Handles localStorage operations with validation and defaults
     */
    class StorageManager {
        constructor() {
            this.storagePrefix = 'schoology-parent-dashboard-';
            this.defaultPreferences = {
                panelCollapsed: false,
                gradeThreshold: 'D',
                upcomingDaysWindow: 7,
                showLowGrades: true,
                showMissingAssignments: true,
                showNegativeComments: true,
                showUpcomingAssignments: true,
                panelPosition: 'right',
                enableNotifications: false,
                markingPeriod: 'current' // 'current', 'MP1', 'MP2', 'MP3', 'MP4', 'Final'
            };
        }

        /**
         * Save a user preference to localStorage
         * @param {string} key - Preference key
         * @param {any} value - Preference value
         * @returns {boolean} Success status
         */
        savePreference(key, value) {
            try {
                const storageKey = this.storagePrefix + key;
                const serializedValue = JSON.stringify(value);
                localStorage.setItem(storageKey, serializedValue);
                console.log(`StorageManager: Saved preference ${key}:`, value);
                return true;
            } catch (error) {
                console.warn('StorageManager: Failed to save preference:', key, error);
                return false;
            }
        }

        /**
         * Load a user preference from localStorage
         * @param {string} key - Preference key
         * @param {any} defaultValue - Default value if not found
         * @returns {any} Preference value or default
         */
        loadPreference(key, defaultValue = null) {
            try {
                const storageKey = this.storagePrefix + key;
                const serializedValue = localStorage.getItem(storageKey);

                if (serializedValue === null) {
                    // Return default from defaultPreferences or provided default
                    const fallback = defaultValue !== null ? defaultValue : this.defaultPreferences[key];
                    console.log(`StorageManager: No stored value for ${key}, using default:`, fallback);
                    return fallback;
                }

                const value = JSON.parse(serializedValue);
                console.log(`StorageManager: Loaded preference ${key}:`, value);
                return value;
            } catch (error) {
                console.warn('StorageManager: Failed to load preference:', key, error);
                const fallback = defaultValue !== null ? defaultValue : this.defaultPreferences[key];
                return fallback;
            }
        }

        /**
         * Load all user preferences
         * @returns {Object} All preferences with defaults for missing values
         */
        loadAllPreferences() {
            const preferences = {};

            // Load each default preference
            for (const [key, defaultValue] of Object.entries(this.defaultPreferences)) {
                preferences[key] = this.loadPreference(key, defaultValue);
            }

            console.log('StorageManager: Loaded all preferences:', preferences);
            return preferences;
        }

        /**
         * Save multiple preferences at once
         * @param {Object} preferences - Object with key-value pairs
         * @returns {boolean} Success status
         */
        savePreferences(preferences) {
            let allSuccessful = true;

            for (const [key, value] of Object.entries(preferences)) {
                if (!this.savePreference(key, value)) {
                    allSuccessful = false;
                }
            }

            return allSuccessful;
        }

        /**
         * Reset a preference to its default value
         * @param {string} key - Preference key
         * @returns {boolean} Success status
         */
        resetPreference(key) {
            if (this.defaultPreferences.hasOwnProperty(key)) {
                return this.savePreference(key, this.defaultPreferences[key]);
            } else {
                console.warn('StorageManager: No default value for preference:', key);
                return false;
            }
        }

        /**
         * Reset all preferences to default values
         * @returns {boolean} Success status
         */
        resetAllPreferences() {
            console.log('StorageManager: Resetting all preferences to defaults');
            return this.savePreferences(this.defaultPreferences);
        }

        /**
         * Remove a preference from storage
         * @param {string} key - Preference key
         * @returns {boolean} Success status
         */
        removePreference(key) {
            try {
                const storageKey = this.storagePrefix + key;
                localStorage.removeItem(storageKey);
                console.log(`StorageManager: Removed preference ${key}`);
                return true;
            } catch (error) {
                console.warn('StorageManager: Failed to remove preference:', key, error);
                return false;
            }
        }

        /**
         * Check if localStorage is available
         * @returns {boolean} Storage availability
         */
        isStorageAvailable() {
            try {
                const testKey = this.storagePrefix + 'test';
                localStorage.setItem(testKey, 'test');
                localStorage.removeItem(testKey);
                return true;
            } catch (error) {
                console.warn('StorageManager: localStorage not available:', error);
                return false;
            }
        }

        /**
         * Get storage usage information
         * @returns {Object} Storage usage stats
         */
        getStorageInfo() {
            const info = {
                available: this.isStorageAvailable(),
                keys: [],
                totalSize: 0
            };

            if (info.available) {
                try {
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key && key.startsWith(this.storagePrefix)) {
                            const value = localStorage.getItem(key);
                            info.keys.push({
                                key: key.replace(this.storagePrefix, ''),
                                size: value ? value.length : 0
                            });
                            info.totalSize += value ? value.length : 0;
                        }
                    }
                } catch (error) {
                    console.warn('StorageManager: Error getting storage info:', error);
                }
            }

            return info;
        }

        /**
         * Validate preference value against expected type/range
         * @param {string} key - Preference key
         * @param {any} value - Value to validate
         * @returns {boolean} Validation result
         */
        validatePreference(key, value) {
            switch (key) {
                case 'panelCollapsed':
                case 'showLowGrades':
                case 'showMissingAssignments':
                case 'showNegativeComments':
                case 'showUpcomingAssignments':
                case 'enableNotifications':
                    return typeof value === 'boolean';

                case 'gradeThreshold':
                    return ['A', 'B', 'C', 'D', 'F'].includes(value);

                case 'upcomingDaysWindow':
                    return typeof value === 'number' && value >= 1 && value <= 30;

                case 'panelPosition':
                    return ['left', 'right'].includes(value);

                default:
                    console.warn('StorageManager: Unknown preference key for validation:', key);
                    return true; // Allow unknown keys
            }
        }

        /**
         * Save preference with validation
         * @param {string} key - Preference key
         * @param {any} value - Preference value
         * @returns {boolean} Success status
         */
        saveValidatedPreference(key, value) {
            if (this.validatePreference(key, value)) {
                return this.savePreference(key, value);
            } else {
                console.warn('StorageManager: Invalid value for preference:', key, value);
                return false;
            }
        }
    }

    /**
     * Configuration UI component for user settings
     */
    class ConfigurationUI {
        constructor(configManager) {
            this.configManager = configManager;
            this.isVisible = false;
        }

        /**
         * Create the configuration panel HTML
         * @returns {HTMLElement} Configuration panel element
         */
        createConfigPanel() {
            const panel = document.createElement('div');
            panel.id = 'schoology-parent-config-panel';
            panel.className = 'schoology-parent-config-panel';
            panel.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border: 2px solid #0066cc;
                border-radius: 8px;
                padding: 20px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                z-index: 10001;
                width: 400px;
                max-height: 80vh;
                overflow-y: auto;
                font-family: Arial, sans-serif;
                display: none;
            `;

            panel.innerHTML = `
                <div class="config-header" style="margin-bottom: 20px; border-bottom: 1px solid #ddd; padding-bottom: 10px;">
                    <h3 style="margin: 0; color: #0066cc;">Parent Dashboard Settings</h3>
                    <button id="config-close-btn" style="float: right; background: none; border: none; font-size: 18px; cursor: pointer; margin-top: -25px;">&times;</button>
                </div>
                
                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Grade Concerns</h4>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="show-low-grades" ${this.configManager.get('showLowGrades') ? 'checked' : ''}>
                        Show low grades
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        Grade threshold (% and below):
                        <input type="number" id="grade-threshold" value="${this.configManager.get('gradeThreshold')}" 
                               min="0" max="100" style="width: 60px; margin-left: 10px;">
                    </label>
                </div>

                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Assignment Concerns</h4>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="show-missing-assignments" ${this.configManager.get('showMissingAssignments') ? 'checked' : ''}>
                        Show missing assignments
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="show-upcoming-assignments" ${this.configManager.get('showUpcomingAssignments') ? 'checked' : ''}>
                        Show upcoming assignments
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        Upcoming window (days):
                        <input type="number" id="upcoming-days" value="${this.configManager.get('upcomingDaysWindow')}" 
                               min="1" max="30" style="width: 60px; margin-left: 10px;">
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        Practice threshold (% and above):
                        <input type="number" id="practice-threshold" value="${this.configManager.get('practiceThreshold')}" 
                               min="0" max="100" style="width: 60px; margin-left: 10px;">
                    </label>
                    <div style="font-size: 11px; color: #666; margin-left: 20px; margin-top: -6px; margin-bottom: 10px;">
                        Hide missing practice assignments when course grade is above this threshold
                    </div>
                </div>

                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Comment Concerns</h4>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="show-negative-comments" ${this.configManager.get('showNegativeComments') ? 'checked' : ''}>
                        Show negative teacher comments
                    </label>
                </div>

                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Section Display</h4>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="checkbox" id="sections-default-expanded" ${this.configManager.get('sectionsDefaultExpanded') ? 'checked' : ''}>
                        Sections expanded by default
                    </label>
                    <div style="font-size: 11px; color: #666; margin-left: 20px; margin-top: 4px;">
                        When unchecked, sections will start collapsed and show only summary information
                    </div>
                </div>

                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Course Filtering</h4>
                    <label style="display: block; margin-bottom: 10px;">
                        Hidden courses (one per line):
                        <textarea id="hidden-courses" style="
                            width: 100%; 
                            height: 60px; 
                            margin-top: 5px; 
                            padding: 8px; 
                            border: 1px solid #ccc; 
                            border-radius: 4px; 
                            font-size: 12px;
                            font-family: monospace;
                        " placeholder="Hereford Connections&#10;Study Hall&#10;Advisory">${(this.configManager.get('hiddenCourses') || []).join('\n')}</textarea>
                    </label>
                    <div style="font-size: 11px; color: #666; margin-top: 4px;">
                        Enter course names or partial names to hide from the dashboard. Each course on a new line.
                    </div>
                </div>

                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Marking Period</h4>
                    <label style="display: block; margin-bottom: 10px;">
                        Focus on marking period:
                        <select id="marking-period" style="margin-left: 10px; padding: 4px;">
                            <option value="current" ${this.configManager.get('markingPeriod') === 'current' ? 'selected' : ''}>Current Period</option>
                            <option value="MP1" ${this.configManager.get('markingPeriod') === 'MP1' ? 'selected' : ''}>MP 1</option>
                            <option value="MP2" ${this.configManager.get('markingPeriod') === 'MP2' ? 'selected' : ''}>MP 2</option>
                            <option value="MP3" ${this.configManager.get('markingPeriod') === 'MP3' ? 'selected' : ''}>MP 3</option>
                            <option value="MP4" ${this.configManager.get('markingPeriod') === 'MP4' ? 'selected' : ''}>MP 4</option>
                            <option value="Final" ${this.configManager.get('markingPeriod') === 'Final' ? 'selected' : ''}>Final Exam</option>
                        </select>
                    </label>
                </div>

                <div class="config-section" style="margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">Sensitivity</h4>
                    <label style="display: block; margin-bottom: 5px;">
                        <input type="radio" name="sensitivity" value="low" ${this.configManager.get('concernSensitivity') === 'low' ? 'checked' : ''}>
                        Low - Only show major concerns
                    </label>
                    <label style="display: block; margin-bottom: 5px;">
                        <input type="radio" name="sensitivity" value="medium" ${this.configManager.get('concernSensitivity') === 'medium' ? 'checked' : ''}>
                        Medium - Balanced concern detection
                    </label>
                    <label style="display: block; margin-bottom: 10px;">
                        <input type="radio" name="sensitivity" value="high" ${this.configManager.get('concernSensitivity') === 'high' ? 'checked' : ''}>
                        High - Show all potential concerns
                    </label>
                </div>

                <div class="config-actions" style="text-align: right; border-top: 1px solid #ddd; padding-top: 15px;">
                    <button id="config-reset-btn" style="background: #dc3545; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-right: 10px;">
                        Reset to Defaults
                    </button>
                    <button id="config-save-btn" style="background: #0066cc; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">
                        Save Settings
                    </button>
                </div>
            `;

            this.attachEventListeners(panel);
            return panel;
        }

        /**
         * Attach event listeners to configuration panel elements
         * @param {HTMLElement} panel - Configuration panel element
         */
        attachEventListeners(panel) {
            // Close button
            panel.querySelector('#config-close-btn').addEventListener('click', () => {
                this.hide();
            });

            // Save button
            panel.querySelector('#config-save-btn').addEventListener('click', () => {
                this.saveConfiguration(panel);
            });

            // Reset button
            panel.querySelector('#config-reset-btn').addEventListener('click', () => {
                if (confirm('Are you sure you want to reset all settings to defaults?')) {
                    this.resetConfiguration(panel);
                }
            });

            // Close on outside click
            panel.addEventListener('click', (e) => {
                if (e.target === panel) {
                    this.hide();
                }
            });
        }

        /**
         * Save configuration from form inputs
         * @param {HTMLElement} panel - Configuration panel element
         */
        saveConfiguration(panel) {
            const config = {
                showLowGrades: panel.querySelector('#show-low-grades').checked,
                showMissingAssignments: panel.querySelector('#show-missing-assignments').checked,
                showUpcomingAssignments: panel.querySelector('#show-upcoming-assignments').checked,
                showNegativeComments: panel.querySelector('#show-negative-comments').checked,
                sectionsDefaultExpanded: panel.querySelector('#sections-default-expanded').checked,
                hiddenCourses: panel.querySelector('#hidden-courses').value.split('\n').map(course => course.trim()).filter(course => course.length > 0),
                gradeThreshold: parseInt(panel.querySelector('#grade-threshold').value),
                upcomingDaysWindow: parseInt(panel.querySelector('#upcoming-days').value),
                practiceThreshold: parseInt(panel.querySelector('#practice-threshold').value),
                concernSensitivity: panel.querySelector('input[name="sensitivity"]:checked').value,
                markingPeriod: panel.querySelector('#marking-period').value
            };

            this.configManager.update(config);
            this.hide();

            // Trigger dashboard refresh if it exists
            if (window.schoolgyParentDashboard && window.schoolgyParentDashboard.refreshDashboard) {
                window.schoolgyParentDashboard.refreshDashboard();
            }

            alert('Settings saved successfully!');
        }

        /**
         * Reset configuration to defaults
         * @param {HTMLElement} panel - Configuration panel element
         */
        resetConfiguration(panel) {
            this.configManager.reset();

            // Update form inputs to reflect defaults
            const defaults = this.configManager.config;
            panel.querySelector('#show-low-grades').checked = defaults.showLowGrades;
            panel.querySelector('#show-missing-assignments').checked = defaults.showMissingAssignments;
            panel.querySelector('#show-upcoming-assignments').checked = defaults.showUpcomingAssignments;
            panel.querySelector('#show-negative-comments').checked = defaults.showNegativeComments;
            panel.querySelector('#sections-default-expanded').checked = defaults.sectionsDefaultExpanded;
            panel.querySelector('#hidden-courses').value = (defaults.hiddenCourses || []).join('\n');
            panel.querySelector('#grade-threshold').value = defaults.gradeThreshold;
            panel.querySelector('#upcoming-days').value = defaults.upcomingDaysWindow;
            panel.querySelector('#practice-threshold').value = defaults.practiceThreshold;
            panel.querySelector(`input[name="sensitivity"][value="${defaults.concernSensitivity}"]`).checked = true;

            alert('Settings reset to defaults!');
        }

        /**
         * Show the configuration panel
         */
        show() {
            let panel = document.getElementById('schoology-parent-config-panel');
            if (!panel) {
                panel = this.createConfigPanel();
                document.body.appendChild(panel);
            }
            panel.style.display = 'block';
            this.isVisible = true;
        }

        /**
         * Hide the configuration panel
         */
        hide() {
            const panel = document.getElementById('schoology-parent-config-panel');
            if (panel) {
                panel.style.display = 'none';
            }
            this.isVisible = false;
        }

        /**
         * Toggle configuration panel visibility
         */
        toggle() {
            if (this.isVisible) {
                this.hide();
            } else {
                this.show();
            }
        }
    }

    // Dynamic monitoring class removed - Schoology grade pages are static after initial load

    // Removed DynamicContentMonitor class (was ~260 lines)


    /**
     * Main Schoology Parent Dashboard class
     * Handles initialization and coordination of all components
     */
    class SchoolgyParentDashboard {
        constructor() {
            this.initialized = false;
            this.isSchoolgyGradePage = false;
            this.dataExtractor = new DataExtractor();
            this.storageManager = new StorageManager();
            this.configManager = new ConfigurationManager();
            this.configUI = new ConfigurationUI(this.configManager);
            this.preferences = {};

            // Dynamic monitoring removed - Schoology grade pages are static after initial load

            // Load user preferences on initialization
            this.loadUserPreferences();
        }

        /**
         * Load user preferences from storage
         * Sets up default preferences if none exist
         */
        loadUserPreferences() {
            console.log('SchoolgyParentDashboard: Loading user preferences...');

            if (!this.storageManager.isStorageAvailable()) {
                console.warn('SchoolgyParentDashboard: localStorage not available, using defaults');
                this.preferences = { ...this.storageManager.defaultPreferences };
                return;
            }

            try {
                this.preferences = this.storageManager.loadAllPreferences();

                // If marking period is set to 'current', detect the actual current period
                if (this.preferences.markingPeriod === 'current') {
                    const dataExtractor = new DataExtractor();
                    const detectedPeriod = dataExtractor.detectCurrentMarkingPeriod();
                    console.log('SchoolgyParentDashboard: Detected current marking period:', detectedPeriod);

                    // Update the preference but don't save it (keep 'current' as the setting)
                    this.currentMarkingPeriod = detectedPeriod;
                } else {
                    this.currentMarkingPeriod = this.preferences.markingPeriod;
                }

                console.log('SchoolgyParentDashboard: Loaded preferences:', this.preferences);
                console.log('SchoolgyParentDashboard: Using marking period:', this.currentMarkingPeriod);
            } catch (error) {
                console.error('SchoolgyParentDashboard: Error loading preferences:', error);
                this.preferences = { ...this.storageManager.defaultPreferences };
                this.currentMarkingPeriod = 'current';
            }
        }

        /**
         * Save user preferences to storage
         * @param {Object} newPreferences - Preferences to save
         * @returns {boolean} Success status
         */
        saveUserPreferences(newPreferences = null) {
            const prefsToSave = newPreferences || this.preferences;

            console.log('SchoolgyParentDashboard: Saving preferences:', prefsToSave);

            if (!this.storageManager.isStorageAvailable()) {
                console.warn('SchoolgyParentDashboard: localStorage not available, cannot save preferences');
                return false;
            }

            try {
                const success = this.storageManager.savePreferences(prefsToSave);
                if (success && newPreferences) {
                    // Update local preferences if new ones were provided
                    this.preferences = { ...this.preferences, ...newPreferences };
                }
                return success;
            } catch (error) {
                console.error('SchoolgyParentDashboard: Error saving preferences:', error);
                return false;
            }
        }

        /**
         * Update a single preference
         * @param {string} key - Preference key
         * @param {any} value - Preference value
         * @returns {boolean} Success status
         */
        updatePreference(key, value) {
            console.log(`SchoolgyParentDashboard: Updating preference ${key}:`, value);

            // Validate the preference
            if (!this.storageManager.validatePreference(key, value)) {
                console.warn('SchoolgyParentDashboard: Invalid preference value:', key, value);
                return false;
            }

            // Update local preferences
            this.preferences[key] = value;

            // Save to storage
            return this.storageManager.saveValidatedPreference(key, value);
        }

        /**
         * Reset preferences to defaults
         * @returns {boolean} Success status
         */
        resetPreferences() {
            console.log('SchoolgyParentDashboard: Resetting preferences to defaults');

            const success = this.storageManager.resetAllPreferences();
            if (success) {
                this.preferences = { ...this.storageManager.defaultPreferences };
            }

            return success;
        }

        /**
         * Get currentthe script when page loads
         * Checks if we're on a valid Schoology grade page and sets up the dashboard
         */
        init() {
            console.log('Schoology Parent Dashboard: Initializing...');
            console.log('Current URL:', window.location.href);
            console.log('Current hostname:', window.location.hostname);

            // Check if we're on a Schoology grade report page
            if (!this.detectSchoolgyGradePage()) {
                console.log('Schoology Parent Dashboard: Not a grade report page, skipping initialization');
                return;
            }

            console.log('Schoology Parent Dashboard: Grade report page detected');
            this.isSchoolgyGradePage = true;

            // Wait for DOM to be fully ready
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.onDOMReady());
            } else {
                this.onDOMReady();
            }
        }

        /**
         * Detect if current page is a Schoology grade report page
         * Uses multiple detection methods for reliability
         * @returns {boolean} True if this is a grade report page
         */
        detectSchoolgyGradePage() {
            // Check URL patterns
            const url = window.location.href;

            // Check if viewing past grades - don't run dashboard on past grades
            if (url.includes('?past=') || url.includes('&past=')) {
                console.log('Schoology Parent Dashboard: Past grades detected in URL, skipping initialization');
                console.log('Past grades URL:', url);
                return false;
            }

            const gradeUrlPatterns = [
                /\/grades/,
                /\/course\/\d+\/grades/,
                /\/user\/\d+\/grades/,
                /\/parent\/grades_attendance\/grades/,
                /\/parent\/.*\/grades/
            ];

            console.log('Checking URL patterns against:', url);
            const hasGradeUrl = gradeUrlPatterns.some(pattern => {
                const matches = pattern.test(url);
                console.log(`Pattern ${pattern} matches: ${matches}`);
                return matches;
            });

            if (!hasGradeUrl) {
                console.log('No grade URL pattern matched');
                return false;
            }
            console.log('Grade URL pattern matched!');

            // Check for Schoology domain
            const isSchoolgyDomain = window.location.hostname.includes('schoology.com');
            console.log('Is Schoology domain:', isSchoolgyDomain);
            if (!isSchoolgyDomain) {
                console.log('Not a Schoology domain');
                return false;
            }

            // Check for grade-specific DOM elements (with fallbacks)
            const gradeIndicators = [
                '.gradebook-course-title',
                '.grade-item',
                '.gradebook-table',
                '[data-drupal-selector="edit-gradebook"]',
                '.s-edge-type-gradebook',
                'table[class*="grade"]',
                '.course-grade'
            ];

            // Use a timeout to allow for dynamic content loading
            const checkDOMElements = () => {
                return gradeIndicators.some(selector => {
                    const elements = document.querySelectorAll(selector);
                    console.log(`Checking selector ${selector}: found ${elements.length} elements`);
                    return elements.length > 0;
                });
            };

            // Check immediately
            console.log('Checking for grade-specific DOM elements...');
            if (checkDOMElements()) {
                console.log('Grade DOM elements found immediately');
                return true;
            }

            // If not found immediately, it might be loading dynamically
            // We'll return true for grade URLs and verify DOM elements later
            console.log('Grade DOM elements not found immediately, but URL matches - proceeding');
            return hasGradeUrl;
        }

        /**
         * Handle DOM ready state
         * Sets up the main dashboard functionality
         */
        onDOMReady() {
            console.log('Schoology Parent Dashboard: DOM ready, setting up dashboard...');

            // Double-check that we have grade content after DOM is ready
            if (!this.verifyGradeContent()) {
                console.log('Schoology Parent Dashboard: No grade content found after DOM ready');
                // Dynamic monitoring removed - grade pages are static after initial load
                return;
            }

            this.setupDashboard();
        }

        /**
         * Verify that grade content is present on the page
         * @returns {boolean} True if grade content is detected
         */
        verifyGradeContent() {
            const gradeContentSelectors = [
                '.gradebook-course-title',
                '.grade-item',
                '.gradebook-table',
                'table[class*="grade"]',
                '.course-grade',
                '[class*="grade"][class*="table"]'
            ];

            return gradeContentSelectors.some(selector => {
                const elements = document.querySelectorAll(selector);
                return elements.length > 0;
            });
        }

        // setupContentObserver method removed - dynamic monitoring not needed

        /**
         * Set up the main dashboard functionality
         * Integrates all components and creates the parent concerns panel
         */
        async setupDashboard() {
            if (this.initialized) {
                return;
            }

            console.log('Schoology Parent Dashboard: Setting up dashboard components...');

            try {
                this.initialized = true;

                // Set up error handling for the entire application
                window.addEventListener('beforeunload', this.cleanup.bind(this));
                window.addEventListener('error', (event) => {
                    this.handleError(event.error, 'global');
                });

                // Test configuration management functionality (Task 5.2) - Disabled in production
                // this.testConfigurationManagement();

                // Hide visual course links based on configuration
                try {
                    console.log('Schoology Parent Dashboard: About to call hideVisualCourseLinks...');
                    this.hideVisualCourseLinks();
                    console.log('Schoology Parent Dashboard: hideVisualCourseLinks completed');
                } catch (error) {
                    console.error('Schoology Parent Dashboard: Error in hideVisualCourseLinks:', error);
                }

                // Scan page content and create the dashboard panel
                console.log('Schoology Parent Dashboard: Scanning page content and creating panel...');
                const success = await this.updatePanel();

                if (success) {
                    console.log('Schoology Parent Dashboard: Dashboard setup complete');
                } else {
                    console.warn('Schoology Parent Dashboard: Dashboard setup completed with errors');
                }

                // Test data extraction functionality (for debugging)
                // Disabled all tests in production to prevent interference
                // if (console.log.toString().includes('native')) {
                //     // Only run detailed tests if console is available (not in production)
                //     this.testDataExtraction();
                // }

            } catch (error) {
                this.handleError(error, 'setupDashboard');
                console.error('Schoology Parent Dashboard: Failed to set up dashboard:', error);
            }
        }

        /**
         * Refresh the dashboard with current configuration settings
         */
        async refreshDashboard() {
            console.log('Refreshing dashboard with updated configuration...');

            if (!this.initialized) {
                console.warn('Dashboard not initialized, cannot refresh');
                return false;
            }

            // Reload preferences to get updated settings including marking period
            this.loadUserPreferences();

            try {
                // Refresh visual course hiding with updated settings
                this.hideVisualCourseLinks();

                // Update the panel with fresh data
                const success = await this.updatePanel();

                if (success) {
                    console.log('Dashboard refreshed successfully');
                } else {
                    console.warn('Dashboard refresh completed with errors');
                }

                return success;

            } catch (error) {
                this.handleError(error, 'refreshDashboard');
                return false;
            }
        }

        /**
         * Run unit tests for configuration management (Task 5.2)
         */
        testConfigurationManagement() {
            console.log('=== Configuration Management Tests ===');

            try {
                // Test 1: Default configuration loading
                const defaultConfig = new ConfigurationManager();
                console.assert(defaultConfig.get('gradeThreshold') === 70, 'Default grade threshold should be 70');
                console.assert(defaultConfig.get('upcomingDaysWindow') === 7, 'Default upcoming window should be 7 days');
                console.assert(defaultConfig.get('concernSensitivity') === 'medium', 'Default sensitivity should be medium');
                console.log('✓ Default configuration test passed');

                // Test 2: Grade threshold functionality
                console.assert(defaultConfig.isGradeConcerning(65) === true, 'Grade 65% should be concerning with 70% threshold');
                console.assert(defaultConfig.isGradeConcerning(75) === false, 'Grade 75% should not be concerning with 70% threshold');
                console.log('✓ Grade threshold test passed');

                // Test 3: Upcoming assignment window
                const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
                const nextWeek = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
                console.assert(defaultConfig.isAssignmentUpcoming(tomorrow) === true, 'Assignment due tomorrow should be upcoming');
                console.assert(defaultConfig.isAssignmentUpcoming(nextWeek) === false, 'Assignment due in 8 days should not be upcoming with 7-day window');
                console.log('✓ Upcoming assignment window test passed');

                // Test 4: Configuration persistence
                const testConfig = new ConfigurationManager();
                testConfig.set('gradeThreshold', 80);
                testConfig.set('upcomingDaysWindow', 14);

                // Create new instance to test persistence
                const loadedConfig = new ConfigurationManager();
                console.assert(loadedConfig.get('gradeThreshold') === 80, 'Grade threshold should persist');
                console.assert(loadedConfig.get('upcomingDaysWindow') === 14, 'Upcoming window should persist');
                console.log('✓ Configuration persistence test passed');

                // Test 5: Sensitivity multiplier
                console.assert(defaultConfig.getSensitivityMultiplier() === 1.0, 'Medium sensitivity should return 1.0 multiplier');
                defaultConfig.set('concernSensitivity', 'high');
                console.assert(defaultConfig.getSensitivityMultiplier() === 1.3, 'High sensitivity should return 1.3 multiplier');
                defaultConfig.set('concernSensitivity', 'low');
                console.assert(defaultConfig.getSensitivityMultiplier() === 0.7, 'Low sensitivity should return 0.7 multiplier');
                console.log('✓ Sensitivity multiplier test passed');

                // Reset to defaults for clean state
                defaultConfig.reset();
                console.log('✓ All configuration management tests passed!');

            } catch (error) {
                console.error('❌ Configuration management test failed:', error);
            }
        }

        /**
         * Test data extraction functionality
         * This method will be removed in later tasks when UI is implemented
         */
        testDataExtraction() {
            console.log('Schoology Parent Dashboard: Testing data extraction...');

            // Debug: Let's see what elements we're actually finding
            console.log('=== DOM Structure Analysis ===');

            // Check for different table structures
            const tables = document.querySelectorAll('table');
            console.log('Found tables:', tables.length);

            const gradeRows = document.querySelectorAll('tr');
            console.log('Found table rows:', gradeRows.length);

            const gradeItems = document.querySelectorAll('.grade-item');
            console.log('Found grade-item elements:', gradeItems.length);

            // Look for parent-specific grade structures
            const parentGradeSelectors = [
                '.gradebook-course-title',
                '.grade-row',
                '.assignment-row',
                'tr[class*="grade"]',
                'tr[class*="assignment"]',
                '.gradebook-table tr',
                'table tr'
            ];

            parentGradeSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                console.log(`Found ${selector}: ${elements.length} elements`);
                if (elements.length > 0 && elements.length < 20) {
                    console.log(`Sample ${selector} HTML:`, elements[0].outerHTML.substring(0, 300));
                }
            });

            // Look for grade/assignment text content
            const textElements = document.querySelectorAll('*');
            let gradeTextElements = [];
            textElements.forEach(el => {
                const text = el.textContent;
                if (text && (text.includes('%') || text.includes('/') || /[A-F][+-]?/.test(text)) && text.length < 50) {
                    gradeTextElements.push({ element: el, text: text.trim() });
                }
            });
            console.log('Elements with grade-like text:', gradeTextElements.slice(0, 5));

            // Debug: Let's examine the actual grade rows that were found
            const actualGradeRows = document.querySelectorAll('tr[class*="grade"]');
            console.log('=== Grade Row Analysis ===');
            actualGradeRows.forEach((row, index) => {
                if (index < 3) { // Only show first 3 to avoid spam
                    console.log(`Grade Row ${index + 1}:`);
                    console.log('- Classes:', row.className);
                    console.log('- Data ID:', row.getAttribute('data-id'));
                    console.log('- HTML snippet:', row.outerHTML.substring(0, 400));

                    // Look for grade values in this row
                    const cells = row.querySelectorAll('td, th');
                    console.log(`- Found ${cells.length} cells`);
                    cells.forEach((cell, cellIndex) => {
                        const text = cell.textContent.trim();
                        if (text && (text.includes('%') || text.includes('/') || /[A-F][+-]?/.test(text)) && text.length < 20) {
                            console.log(`  Cell ${cellIndex}: "${text}"`);
                        }
                    });
                }
            });

            // Debug: Let's also look at assignment name extraction
            console.log('=== Assignment Name Analysis ===');
            actualGradeRows.forEach((row, index) => {
                if (index < 2) {
                    const titleCell = row.querySelector('.title-column, th, td:first-child');
                    if (titleCell) {
                        console.log(`Row ${index + 1} title cell:`, titleCell.textContent.trim().substring(0, 100));
                    }
                }
            });

            this.dataExtractor.extractGrades().then(allGrades => {
                console.log('Extracted all grades:', allGrades);

                // Filter grades by selected marking period
                const grades = this.dataExtractor.filterGradesByMarkingPeriod(allGrades, this.currentMarkingPeriod);
                console.log(`Filtered grades for ${this.currentMarkingPeriod}:`, grades);

                const assignments = this.dataExtractor.extractAssignments();
                console.log('Extracted assignments:', assignments);

                const comments = this.dataExtractor.extractComments();
                console.log('Extracted comments:', comments);

                // Debug comment structure
                if (comments.length > 0) {
                    console.log('=== Comment Analysis ===');
                    comments.forEach((comment, index) => {
                        console.log(`Comment ${index + 1}:`, {
                            text: comment.comment,
                            assignment: comment.assignmentName,
                            subject: comment.subject,
                            teacher: comment.teacher,
                            date: comment.date
                        });
                    });
                }

                if (grades.length > 0) {
                    console.log('Sample grade data:', grades[0]);
                }

                if (assignments.length > 0) {
                    console.log('Sample assignment data:', assignments[0]);
                }

                if (comments.length > 0) {
                    console.log('Sample comment data:', comments[0]);
                }

                // Implement sentiment analysis for comments (Task 3.3)
                const commentAnalysis = this.analyzeCommentSentiment(comments);
                console.log('Comment sentiment analysis:', commentAnalysis);

                // Implement grade analysis functionality (Task 3.1)
                const gradeAnalysis = this.analyzeGrades(grades);
                console.log('Grade analysis:', gradeAnalysis);

                // Implement missing assignment detection (Task 3.2)
                const missingAssignments = this.detectMissingAssignments(assignments, grades);
                console.log('Missing assignments:', missingAssignments);

                // Implement upcoming assignment analysis (Task 3.4)
                const upcomingAnalysis = this.analyzeUpcomingAssignments(assignments, grades);
                console.log('Upcoming assignments analysis:', upcomingAnalysis);

                // Test storage management functionality (Task 5.1) - Disabled in production
                // this.testStorageManagement();

                // Test main controller integration (Task 6.1) - Disabled in production
                // this.testMainController();

                // Create the main parent concerns dashboard (Task 4.1)
                this.createParentDashboard(grades, assignments, comments, commentAnalysis, gradeAnalysis, missingAssignments, upcomingAnalysis);
            });
        }

        /**
         * Test storage management functionality (Task 5.1)
         * This method will be removed in later tasks when UI is implemented
         */
        testStorageManagement() {
            console.log('=== STORAGE MANAGEMENT TESTS ===');

            // Test 1: Storage availability
            const storageAvailable = this.storageManager.isStorageAvailable();
            console.log('Storage available:', storageAvailable);

            if (!storageAvailable) {
                console.warn('Storage tests skipped - localStorage not available');
                return;
            }

            // Test 2: Save and load preferences
            const testPrefs = {
                panelCollapsed: true,
                gradeThreshold: 'C',
                upcomingDaysWindow: 14
            };

            console.log('Testing preference save/load...');
            const saveSuccess = this.storageManager.savePreferences(testPrefs);
            console.log('Save success:', saveSuccess);

            const loadedPrefs = this.storageManager.loadAllPreferences();
            console.log('Loaded preferences:', loadedPrefs);

            // Test 3: Individual preference operations
            console.log('Testing individual preference operations...');
            const singleSaveSuccess = this.storageManager.saveValidatedPreference('showLowGrades', false);
            console.log('Single save success:', singleSaveSuccess);

            const singleLoadValue = this.storageManager.loadPreference('showLowGrades');
            console.log('Single load value:', singleLoadValue);

            // Test 4: Validation
            console.log('Testing preference validation...');
            const validGrade = this.storageManager.validatePreference('gradeThreshold', 'B');
            const invalidGrade = this.storageManager.validatePreference('gradeThreshold', 'X');
            console.log('Valid grade threshold (B):', validGrade);
            console.log('Invalid grade threshold (X):', invalidGrade);

            const validDays = this.storageManager.validatePreference('upcomingDaysWindow', 7);
            const invalidDays = this.storageManager.validatePreference('upcomingDaysWindow', 50);
            console.log('Valid days window (7):', validDays);
            console.log('Invalid days window (50):', invalidDays);

            // Test 5: Storage info
            const storageInfo = this.storageManager.getStorageInfo();
            console.log('Storage info:', storageInfo);

            // Test 6: Dashboard preference methods
            console.log('Testing dashboard preference methods...');
            const updateSuccess = this.updatePreference('panelCollapsed', false);
            console.log('Update preference success:', updateSuccess);
            console.log('Current preferences after update:', this.preferences);

            // Test 7: Reset functionality
            console.log('Testing reset functionality...');
            const resetSuccess = this.storageManager.resetPreference('gradeThreshold');
            console.log('Reset single preference success:', resetSuccess);

            const defaultValue = this.storageManager.loadPreference('gradeThreshold');
            console.log('Grade threshold after reset:', defaultValue);

            console.log('=== STORAGE MANAGEMENT TESTS COMPLETE ===');
        }

        /**
         * Run integration tests for the main application controller (Task 6.1)
         * Tests the complete workflow from initialization to panel display
         */
        async testMainController() {
            console.log('=== MAIN CONTROLLER INTEGRATION TESTS ===');

            try {
                // Test 1: Page content scanning
                console.log('Testing page content scanning...');
                const scannedData = await this.scanPageContent();
                console.assert(scannedData !== null, 'scanPageContent should return data object');
                console.assert(typeof scannedData === 'object', 'scanPageContent should return object');
                console.assert(Array.isArray(scannedData.grades), 'scannedData should contain grades array');
                console.assert(Array.isArray(scannedData.assignments), 'scannedData should contain assignments array');
                console.assert(Array.isArray(scannedData.comments), 'scannedData should contain comments array');
                console.assert(scannedData.analysis !== undefined, 'scannedData should contain analysis object');
                console.log('✓ Page content scanning test passed');

                // Test 2: Panel update functionality
                console.log('Testing panel update functionality...');
                const updateSuccess = await this.updatePanel(scannedData);
                console.assert(typeof updateSuccess === 'boolean', 'updatePanel should return boolean');
                console.log('✓ Panel update test passed');

                // Test 3: Error handling
                console.log('Testing error handling...');
                const originalConsoleError = console.error;
                let errorHandled = false;
                console.error = (...args) => {
                    if (args[0] && args[0].includes('SchoolgyParentDashboard: Error in test:')) {
                        errorHandled = true;
                    }
                    originalConsoleError.apply(console, args);
                };

                this.handleError(new Error('Test error'), 'test');
                console.assert(errorHandled, 'Error should be handled and logged');
                console.error = originalConsoleError;
                console.log('✓ Error handling test passed');

                // Dynamic monitoring tests removed - no longer needed

                // Test 5: Component integration
                console.log('Testing component integration...');
                console.assert(this.dataExtractor instanceof DataExtractor, 'DataExtractor should be initialized');
                console.assert(this.storageManager instanceof StorageManager, 'StorageManager should be initialized');
                console.assert(this.configManager instanceof ConfigurationManager, 'ConfigurationManager should be initialized');
                console.log('✓ Component integration test passed');

                console.log('✓ All main controller integration tests passed!');
                return true;

            } catch (error) {
                console.error('❌ Main controller integration test failed:', error);
                return false;
            }
        }

        /**
         * Analyze teacher comments for negative sentiment (Task 3.3)
         * @param {Array} comments - Array of comment objects
         * @returns {Object} Analysis results with negative comments and statistics
         */
        analyzeCommentSentiment(comments) {
            console.log('Analyzing comment sentiment...');

            const negativeKeywords = [
                // Direct negative indicators
                'missing', 'late', 'incomplete', 'poor', 'needs improvement',
                'concern', 'struggling', 'behind', 'failing', 'unsatisfactory',
                'not submitted', 'absent', 'overdue', 'unfinished', 'lacking',

                // Performance issues
                'difficulty', 'trouble', 'confused', 'unclear', 'weak',
                'insufficient', 'below', 'under', 'low', 'minimal',

                // Behavioral concerns
                'disruptive', 'unfocused', 'distracted', 'off-task', 'unprepared',
                'careless', 'rushed', 'sloppy', 'inattentive',

                // Academic concerns
                'revision needed', 'redo', 'resubmit', 'incorrect', 'wrong',
                'misunderstood', 'missed', 'skipped', 'incomplete understanding'
            ];

            const positiveKeywords = [
                'excellent', 'great', 'good', 'well done', 'outstanding',
                'improvement', 'progress', 'better', 'nice work', 'keep up',
                'strong', 'solid', 'thorough', 'complete', 'successful'
            ];

            const negativeComments = [];
            const neutralComments = [];
            const positiveComments = [];

            comments.forEach(comment => {
                const text = comment.comment.toLowerCase();

                // Skip very short or placeholder comments
                if (!text || text.length < 10 || text === 'comment:') {
                    return;
                }

                let negativeScore = 0;
                let positiveScore = 0;

                // Count negative keywords
                negativeKeywords.forEach(keyword => {
                    if (text.includes(keyword.toLowerCase())) {
                        negativeScore += 1;
                        // Weight certain keywords more heavily
                        if (['failing', 'missing', 'concern', 'struggling', 'poor'].includes(keyword)) {
                            negativeScore += 1;
                        }
                    }
                });

                // Count positive keywords
                positiveKeywords.forEach(keyword => {
                    if (text.includes(keyword.toLowerCase())) {
                        positiveScore += 1;
                    }
                });

                // Determine sentiment
                const enhancedComment = {
                    ...comment,
                    negativeScore: negativeScore,
                    positiveScore: positiveScore,
                    sentiment: negativeScore > positiveScore ? 'negative' :
                        positiveScore > negativeScore ? 'positive' : 'neutral',
                    severity: negativeScore >= 3 ? 'high' :
                        negativeScore >= 2 ? 'medium' :
                            negativeScore >= 1 ? 'low' : 'none',
                    truncatedComment: comment.comment.length > 100 ?
                        comment.comment.substring(0, 100) + '...' :
                        comment.comment,
                    fullComment: comment.comment
                };

                if (negativeScore > positiveScore) {
                    negativeComments.push(enhancedComment);
                } else if (positiveScore > negativeScore) {
                    positiveComments.push(enhancedComment);
                } else {
                    neutralComments.push(enhancedComment);
                }
            });

            // Sort negative comments by severity (highest first)
            negativeComments.sort((a, b) => b.negativeScore - a.negativeScore);

            const analysis = {
                totalComments: comments.length,
                negativeComments: negativeComments,
                positiveComments: positiveComments,
                neutralComments: neutralComments,
                negativeCount: negativeComments.length,
                positiveCount: positiveComments.length,
                neutralCount: neutralComments.length,
                hasNegativeComments: negativeComments.length > 0,
                severityBreakdown: {
                    high: negativeComments.filter(c => c.severity === 'high').length,
                    medium: negativeComments.filter(c => c.severity === 'medium').length,
                    low: negativeComments.filter(c => c.severity === 'low').length
                }
            };

            console.log('Sentiment analysis complete:', {
                total: analysis.totalComments,
                negative: analysis.negativeCount,
                positive: analysis.positiveCount,
                neutral: analysis.neutralCount,
                severity: analysis.severityBreakdown
            });

            return analysis;
        }

        /**
         * Analyze grades for patterns and concerns (Task 3.1)
         * @param {Array} grades - Array of grade objects
         * @returns {Object} Analysis results with grade statistics and concerns
         */
        analyzeGrades(grades) {
            console.log('Analyzing grades...');

            if (!grades || grades.length === 0) {
                return {
                    totalGrades: 0,
                    hasGrades: false,
                    message: 'No grades found to analyze'
                };
            }

            // Filter out hidden courses
            const filteredGrades = grades.filter(grade => {
                if (!grade.subject) return true; // Keep grades without subject info
                return !this.configManager.isCourseHidden(grade.subject);
            });

            console.log(`Filtered ${grades.length - filteredGrades.length} grades from hidden courses`);

            if (filteredGrades.length === 0) {
                return {
                    totalGrades: 0,
                    hasGrades: false,
                    message: 'All grades are from hidden courses'
                };
            }

            const analysis = {
                totalGrades: 0, // Will be calculated based on actual grades with values
                hasGrades: true,
                gradeBreakdown: { A: 0, B: 0, C: 0, D: 0, F: 0, other: 0 },
                concerningGrades: [],
                averageGrade: null,
                trendAnalysis: null,
                subjects: new Set()
            };

            let numericGrades = [];
            let letterGrades = [];
            let validGradeCount = 0;

            filteredGrades.forEach(grade => {
                // Track subjects
                if (grade.subject) {
                    analysis.subjects.add(grade.subject);
                }

                // Analyze grade values - handle new format with letter and points
                if (grade.grade &&
                    grade.grade !== 'Exempt' &&
                    grade.grade !== null &&
                    grade.grade !== '' &&
                    grade.grade !== 'Missing' &&
                    grade.grade !== 'WaitingForGrading' &&
                    grade.grade !== 'M' &&
                    // Additional exempt checks
                    (typeof grade.grade !== 'string' || !grade.grade.toLowerCase().includes('exempt')) &&
                    // Check if assignment name suggests it's exempt
                    (!grade.assignmentName || !grade.assignmentName.toLowerCase().includes('exempt'))) {

                    // Additional filtering for realistic grades
                    let isValidGrade = false;

                    if (typeof grade.grade === 'string') {
                        // Letter grades (A, B, C, D, F with optional +/-)
                        isValidGrade = /^[A-F][+-]?$/.test(grade.grade.toUpperCase());
                    } else if (typeof grade.grade === 'number') {
                        // Percentage grades (0% and above, including extra credit)
                        isValidGrade = grade.grade >= 0;
                    } else if (typeof grade.grade === 'object' && grade.grade.percentage !== undefined) {
                        // Object with percentage (0% and above, including extra credit)
                        isValidGrade = grade.grade.percentage >= 0;
                    }

                    if (isValidGrade) {
                        // TEMPORARY DEBUG: Only count grades that will actually be categorized
                        let willBeCategorized = false;
                        let gradeStr = '';
                        let percentage = null;

                        // Handle different grade formats (same logic as below)
                        if (typeof grade.grade === 'object' && grade.grade.letter) {
                            gradeStr = grade.grade.letter.toUpperCase();
                            percentage = grade.grade.percentage;
                            willBeCategorized = true;
                        } else if (typeof grade.grade === 'string') {
                            gradeStr = grade.grade.toString().toUpperCase();
                            willBeCategorized = /^[A-F][+-]?$/.test(gradeStr);
                        } else if (typeof grade.grade === 'number') {
                            percentage = grade.grade;
                            willBeCategorized = true;
                        }

                        if (willBeCategorized) {
                            validGradeCount++; // Count only grades that will be categorized
                        }
                    }
                    let gradeStr = '';
                    let percentage = null;

                    // Handle different grade formats
                    if (typeof grade.grade === 'object' && grade.grade.letter) {
                        // New format: {letter: 'A', earned: 3, total: 3, percentage: 100}
                        gradeStr = grade.grade.letter.toUpperCase();
                        percentage = grade.grade.percentage;
                    } else if (typeof grade.grade === 'string') {
                        gradeStr = grade.grade.toString().toUpperCase();
                    } else if (typeof grade.grade === 'number') {
                        percentage = grade.grade;
                        // Convert percentage to letter grade
                        if (percentage >= 90) gradeStr = 'A';
                        else if (percentage >= 80) gradeStr = 'B';
                        else if (percentage >= 70) gradeStr = 'C';
                        else if (percentage >= 60) gradeStr = 'D';
                        else gradeStr = 'F';
                    }

                    // Letter grade analysis
                    if (gradeStr.includes('A')) {
                        analysis.gradeBreakdown.A++;
                        letterGrades.push('A');
                    } else if (gradeStr.includes('B')) {
                        analysis.gradeBreakdown.B++;
                        letterGrades.push('B');
                    } else if (gradeStr.includes('C')) {
                        analysis.gradeBreakdown.C++;
                        letterGrades.push('C');
                    } else if (gradeStr.includes('D')) {
                        analysis.gradeBreakdown.D++;
                        letterGrades.push('D');
                    } else if (gradeStr.includes('F')) {
                        analysis.gradeBreakdown.F++;
                        letterGrades.push('F');
                    } else {
                        analysis.gradeBreakdown.other++;
                    }

                    // Check if grade is concerning based on configurable threshold
                    const gradeThreshold = this.configManager.getGradeThreshold();
                    let isGradeConcerning = false;

                    // Handle edge case: grades with 0 total points (like 1/0) should not be concerning
                    // These are typically extra credit or bonus assignments
                    if (typeof grade.grade === 'object' && grade.grade.total === 0) {
                        isGradeConcerning = false; // Never flag 0-point assignments as concerning
                    } else if (percentage !== null) {
                        // Use actual percentage if available
                        isGradeConcerning = this.configManager.isGradeConcerning(percentage);
                    } else {
                        // Convert letter grade to percentage for threshold comparison
                        const letterToPercent = { 'A': 95, 'B': 85, 'C': 75, 'D': 65, 'F': 50 };
                        const letter = gradeStr.charAt(0);
                        if (letterToPercent[letter]) {
                            isGradeConcerning = this.configManager.isGradeConcerning(letterToPercent[letter]);
                        }
                    }

                    if (isGradeConcerning) {
                        let concernLevel = 'Below threshold';
                        if (percentage !== null) {
                            if (percentage < 60) concernLevel = 'Failing grade - immediate attention required';
                            else if (percentage < gradeThreshold) concernLevel = 'Below grade threshold - needs attention';
                        } else if (gradeStr.includes('F')) {
                            concernLevel = 'Failing grade - immediate attention required';
                        } else if (gradeStr.includes('D')) {
                            concernLevel = 'Poor performance - needs attention';
                        }

                        analysis.concerningGrades.push({
                            assignment: grade.assignmentName,
                            grade: grade.grade,
                            subject: grade.subject,
                            concern: concernLevel,
                            percentage: percentage
                        });
                    }

                    // Use percentage if available, otherwise convert letter to approximate percentage
                    if (percentage !== null) {
                        numericGrades.push(percentage);
                    } else {
                        const letterToPercent = { 'A': 95, 'B': 85, 'C': 75, 'D': 65, 'F': 50 };
                        const letter = gradeStr.charAt(0);
                        if (letterToPercent[letter]) {
                            numericGrades.push(letterToPercent[letter]);
                        }
                    }
                }
            });

            // Calculate average if we have numeric grades
            if (numericGrades.length > 0) {
                analysis.averageGrade = numericGrades.reduce((sum, grade) => sum + grade, 0) / numericGrades.length;
                analysis.averageGrade = Math.round(analysis.averageGrade * 10) / 10; // Round to 1 decimal
            }

            // Determine overall performance level
            const totalConcerning = analysis.gradeBreakdown.C + analysis.gradeBreakdown.D + analysis.gradeBreakdown.F;
            analysis.performanceLevel = totalConcerning === 0 ? 'excellent' :
                totalConcerning <= 1 ? 'good' :
                    totalConcerning <= 2 ? 'needs_attention' : 'concerning';

            analysis.subjectCount = analysis.subjects.size;
            analysis.subjects = Array.from(analysis.subjects);

            // Set the correct total grade count (only grades with actual values)
            analysis.totalGrades = validGradeCount;

            console.log('Grade analysis complete:', {
                total: analysis.totalGrades,
                average: analysis.averageGrade,
                performance: analysis.performanceLevel,
                concerning: analysis.concerningGrades.length
            });

            return analysis;
        }

        /**
         * Check if an assignment is a practice assignment
         * @param {Object} assignment - Assignment object with name and subject
         * @returns {boolean} True if assignment is practice/homework
         */
        isPracticeAssignment(assignment) {
            if (!assignment || !assignment.name) return false;

            const assignmentName = assignment.name.toLowerCase();
            const practiceKeywords = [
                'practice', 'homework', 'hw', 'drill', 'exercise', 'worksheet',
                'warm-up', 'warmup', 'review', 'prep', 'preparation'
            ];

            const isPractice = practiceKeywords.some(keyword => assignmentName.includes(keyword));
            console.log(`isPracticeAssignment: "${assignment.name}" -> ${isPractice} (keywords: ${practiceKeywords.filter(k => assignmentName.includes(k)).join(', ')})`);
            return isPractice;
        }

        /**
         * Check if assignment is in a practice section of the course
         * @param {Object} assignment - Assignment object
         * @returns {boolean} True if assignment is in practice section
         */
        isInPracticeSection(assignment) {
            if (!assignment || !assignment.category) {
                console.log(`isInPracticeSection: No category for assignment "${assignment ? assignment.name : 'null'}"`);
                return false;
            }

            const category = assignment.category.toLowerCase();
            const practiceSections = [
                'practice', 'homework', 'classwork', 'warm-up', 'warmup',
                'drill', 'exercise', 'review', 'preparation'
            ];

            const isInPractice = practiceSections.some(section => category.includes(section));
            console.log(`isInPracticeSection: "${assignment.name}" category "${assignment.category}" -> ${isInPractice}`);
            return isInPractice;
        }

        /**
         * Get current course grade percentage
         * @param {string} subject - Course subject name
         * @param {Array} grades - Array of all grades
         * @returns {number|null} Course grade percentage or null if cannot determine
         */
        getCurrentCourseGrade(subject, grades) {
            if (!subject || !grades || grades.length === 0) {
                console.log(`getCurrentCourseGrade: Invalid input - subject: ${subject}, grades: ${grades ? grades.length : 'null'}`);
                return null;
            }

            console.log(`getCurrentCourseGrade: Looking for overall course grade for "${subject}"`);

            // First, try to find the overall course grade directly from Schoology's grade display
            // Look for the course-level grade that Schoology calculates
            try {
                const courseElements = document.querySelectorAll('*');
                for (const element of courseElements) {
                    const text = element.textContent;
                    if (text && text.includes(subject.replace('Course', ''))) {
                        // Look for grade patterns like "B (89%)" in the same area
                        const gradeMatch = text.match(/([A-F][+-]?)\s*\((\d+)%\)/);
                        if (gradeMatch) {
                            const percentage = parseInt(gradeMatch[2]);
                            console.log(`getCurrentCourseGrade: Found Schoology course grade: ${gradeMatch[1]} (${percentage}%)`);
                            return percentage;
                        }
                    }
                }
            } catch (error) {
                console.log(`getCurrentCourseGrade: Error finding course grade from DOM: ${error.message}`);
            }

            // Fallback: Calculate weighted average by category
            console.log(`getCurrentCourseGrade: Calculating weighted average for ${subject}`);

            // Group grades by category
            const categorizedGrades = {};
            grades.forEach(grade => {
                if (grade.subject !== subject) return;

                let numericGrade = null;
                if (typeof grade.grade === 'number') {
                    numericGrade = grade.grade;
                } else if (typeof grade.grade === 'object' && grade.grade !== null) {
                    if (grade.grade.percentage !== undefined) {
                        numericGrade = grade.grade.percentage;
                    } else if (grade.grade.earned !== undefined && grade.grade.total !== undefined && grade.grade.total > 0) {
                        numericGrade = (grade.grade.earned / grade.grade.total) * 100;
                    }
                }

                if (numericGrade !== null && numericGrade >= 0 && numericGrade <= 100 &&
                    grade.grade !== 'Missing' && grade.grade !== 'WaitingForGrading' && grade.grade !== 'M') {

                    const category = grade.category || 'General';
                    if (!categorizedGrades[category]) {
                        categorizedGrades[category] = [];
                    }
                    categorizedGrades[category].push(numericGrade);
                }
            });

            // Calculate category averages (excluding Practice for this calculation)
            let weightedSum = 0;
            let totalWeight = 0;

            for (const [category, gradeList] of Object.entries(categorizedGrades)) {
                if (gradeList.length === 0) continue;

                const categoryAverage = gradeList.reduce((sum, grade) => sum + grade, 0) / gradeList.length;

                // Use typical weights: Major=30%, Minor=70%, ignore Practice for overall grade
                let weight = 0;
                if (category.toLowerCase().includes('major')) {
                    weight = 0.3;
                } else if (category.toLowerCase().includes('minor')) {
                    weight = 0.7;
                }

                if (weight > 0) {
                    weightedSum += categoryAverage * weight;
                    totalWeight += weight;
                    console.log(`  ${category}: ${Math.round(categoryAverage)}% (weight: ${weight})`);
                }
            }

            if (totalWeight === 0) {
                console.log(`getCurrentCourseGrade: No weighted categories found, using simple average`);
                // Fallback to simple average if no weighted categories
                const allGrades = Object.values(categorizedGrades).flat();
                if (allGrades.length === 0) return null;
                const average = Math.round(allGrades.reduce((sum, grade) => sum + grade, 0) / allGrades.length);
                console.log(`getCurrentCourseGrade: Simple average for ${subject}: ${average}%`);
                return average;
            }

            const weightedAverage = Math.round(weightedSum / totalWeight);
            console.log(`getCurrentCourseGrade: Weighted average for ${subject}: ${weightedAverage}%`);
            return weightedAverage;
        }

        /**
         * Check if missing practice assignment should be ignored based on course grade
         * @param {Object} assignment - Assignment object
         * @param {Array} grades - Array of all grades
         * @returns {boolean} True if practice assignment should be ignored
         */
        shouldIgnorePracticeAssignment(assignment, grades) {
            console.log(`shouldIgnorePracticeAssignment called for: "${assignment.name}" in subject "${assignment.subject}"`);

            // Check if this is a practice assignment
            const isPractice = this.isPracticeAssignment(assignment) || this.isInPracticeSection(assignment);
            console.log(`  isPractice: ${isPractice}`);
            if (!isPractice) return false;

            // Get current course grade
            const courseGrade = this.getCurrentCourseGrade(assignment.subject, grades);
            console.log(`  courseGrade: ${courseGrade}`);
            if (courseGrade === null) return false; // Can't determine grade, don't ignore

            // Get practice threshold from configuration
            const practiceThreshold = this.configManager.get('practiceThreshold') || 80;
            console.log(`  practiceThreshold: ${practiceThreshold}`);

            const shouldIgnore = courseGrade > practiceThreshold;
            console.log(`Practice assignment check: "${assignment.name}" in ${assignment.subject} - Course grade: ${courseGrade}%, Threshold: ${practiceThreshold}%, Should ignore: ${shouldIgnore}`);

            // Ignore if course grade is above threshold
            return shouldIgnore;
        }

        /**
         * Detect missing assignments (Task 3.2)
         * @param {Array} assignments - Array of assignment objects
         * @param {Array} grades - Array of grade objects
         * @returns {Object} Missing assignment analysis
         */
        detectMissingAssignments(assignments, grades) {
            console.log('Detecting missing assignments...');
            console.log('Input data:', {
                assignments: assignments.length,
                grades: grades.length,
                sampleGrades: grades.slice(0, 3).map(g => ({
                    name: g.assignmentName,
                    grade: g.grade,
                    status: g.status,
                    subject: g.subject
                }))
            });

            // Debug: Show all unique subjects in grades
            const subjects = [...new Set(grades.map(g => g.subject))];
            console.log('All subjects in grades:', subjects);

            const analysis = {
                totalAssignments: assignments.filter(a => a.name && a.name.trim() !== '' && !a.name.toLowerCase().includes('exempt') && a.status !== 'exempt' && a.status !== 'excused').length,
                totalGrades: grades.length,
                missingSubmissions: [],
                lateSubmissions: [],
                waitingForGrading: [],
                upcomingDueDates: [],
                hasMissingWork: false
            };

            // Look for assignments without grades (missing submissions)
            const gradedAssignments = new Set(grades.map(g => g.assignmentName));

            assignments.forEach(assignment => {
                if (!gradedAssignments.has(assignment.name)) {
                    // Check if this is a practice assignment that should be ignored
                    if (this.shouldIgnorePracticeAssignment(assignment, grades)) {
                        console.log(`Ignoring missing practice assignment "${assignment.name}" - course grade above threshold`);
                        return;
                    }

                    analysis.missingSubmissions.push({
                        name: assignment.name,
                        subject: assignment.subject,
                        dueDate: assignment.dueDate,
                        status: 'not_submitted'
                    });
                }
            });

            // Check grades themselves for missing status indicators
            grades.forEach(grade => {
                // Skip hidden courses
                if (grade.subject && this.configManager.isCourseHidden(grade.subject)) {
                    return;
                }

                // Skip excused assignments
                if (grade.grade === 'Excused' || grade.grade === 'Exempt' ||
                    (typeof grade.grade === 'string' && (grade.grade.toLowerCase().includes('excused') || grade.grade.toLowerCase().includes('exempt')))) {
                    console.log(`Skipping excused/exempt grade: "${grade.assignmentName}" with grade "${grade.grade}"`);
                    return;
                }

                // Check if grade is explicitly marked as missing or waiting for grading
                if (grade.grade === 'Missing' || grade.grade === 'M' ||
                    (typeof grade.grade === 'string' && grade.grade.toLowerCase().includes('missing'))) {

                    // Check if this is a practice assignment that should be ignored
                    const assignmentObj = { name: grade.assignmentName, subject: grade.subject, category: grade.category };
                    if (this.shouldIgnorePracticeAssignment(assignmentObj, grades)) {
                        console.log(`Ignoring missing practice assignment "${grade.assignmentName}" - course grade above threshold`);
                        return;
                    }

                    analysis.missingSubmissions.push({
                        name: grade.assignmentName,
                        subject: grade.subject,
                        dueDate: null,
                        status: 'missing'
                    });
                } else if (grade.grade === 'WaitingForGrading') {
                    analysis.waitingForGrading.push({
                        name: grade.assignmentName,
                        subject: grade.subject,
                        dueDate: null,
                        status: 'waiting_for_grading'
                    });
                }

                // Check if assignment is submitted but waiting for grading (paper emoji or specific text)
                if (grade.status) {
                    const status = grade.status.toLowerCase();
                    if (status.includes('submitted') && status.includes('not') && status.includes('graded') ||
                        status.includes('waiting') ||
                        status.includes('pending') ||
                        grade.grade === 0 && status.includes('submitted')) {
                        analysis.waitingForGrading.push({
                            name: grade.assignmentName,
                            subject: grade.subject,
                            dueDate: null,
                            status: 'waiting_for_grading'
                        });
                    }
                }

                // Check if grade has missing status
                if (grade.status) {
                    const status = grade.status.toLowerCase();

                    // Skip excused/exempt assignments
                    if (status.includes('excused') || status.includes('exempt') || status.includes('absent')) {
                        console.log(`Skipping excused/exempt assignment: "${grade.assignmentName}" with status "${grade.status}"`);
                        return;
                    }

                    if (status.includes('missing') || status.includes('not_submitted')) {
                        // Check if this is a practice assignment that should be ignored
                        const assignmentObj = { name: grade.assignmentName, subject: grade.subject, category: grade.category };
                        if (this.shouldIgnorePracticeAssignment(assignmentObj, grades)) {
                            console.log(`Ignoring missing practice assignment "${grade.assignmentName}" - course grade above threshold`);
                            return;
                        }

                        analysis.missingSubmissions.push({
                            name: grade.assignmentName,
                            subject: grade.subject,
                            dueDate: null,
                            status: grade.status
                        });
                    } else if (status.includes('late') || status.includes('overdue')) {
                        analysis.lateSubmissions.push({
                            name: grade.assignmentName,
                            subject: grade.subject,
                            dueDate: null,
                            status: grade.status
                        });
                    }
                }
            });

            // Look for assignments marked as late or missing in status
            assignments.forEach(assignment => {
                if (assignment.status) {
                    const status = assignment.status.toLowerCase();

                    // Skip excused/exempt assignments
                    if (status.includes('excused') || status.includes('exempt') || status.includes('absent')) {
                        console.log(`Skipping excused/exempt assignment: "${assignment.name}" with status "${assignment.status}"`);
                        return;
                    }

                    if (status.includes('late') || status.includes('overdue')) {
                        analysis.lateSubmissions.push({
                            name: assignment.name,
                            subject: assignment.subject,
                            dueDate: assignment.dueDate,
                            status: assignment.status
                        });
                    } else if (status.includes('missing') || status.includes('not_submitted')) {
                        // Check if this is a practice assignment that should be ignored
                        if (this.shouldIgnorePracticeAssignment(assignment, grades)) {
                            console.log(`Ignoring missing practice assignment "${assignment.name}" - course grade above threshold`);
                            return;
                        }

                        analysis.missingSubmissions.push({
                            name: assignment.name,
                            subject: assignment.subject,
                            dueDate: assignment.dueDate,
                            status: assignment.status
                        });
                    }
                }
            });

            // Check for upcoming due dates (within next 7 days)
            const now = new Date();
            const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

            assignments.forEach(assignment => {
                if (assignment.dueDate) {
                    const dueDate = new Date(assignment.dueDate);
                    if (dueDate > now && dueDate <= nextWeek) {
                        analysis.upcomingDueDates.push({
                            name: assignment.name,
                            subject: assignment.subject,
                            dueDate: assignment.dueDate,
                            daysUntilDue: Math.ceil((dueDate - now) / (24 * 60 * 60 * 1000))
                        });
                    }
                }
            });

            analysis.hasMissingWork = analysis.missingSubmissions.length > 0 || analysis.lateSubmissions.length > 0;
            analysis.totalMissing = analysis.missingSubmissions.length;
            analysis.totalLate = analysis.lateSubmissions.length;
            analysis.totalUpcoming = analysis.upcomingDueDates.length;

            // Enhanced missing assignment detection from DOM
            try {
                const assignmentRows = document.querySelectorAll('tr');
                assignmentRows.forEach(row => {
                    try {
                        const rowText = row.textContent;
                        if (!rowText) return;

                        // Extract assignment name and subject from this row
                        const assignmentName = this.dataExtractor.extractAssignmentName(row);
                        const subject = this.dataExtractor.extractSubject(row);

                        if (!assignmentName) return;

                        // Check for assignments marked as "Missing"
                        if (rowText.includes('Missing')) {
                            console.log('Found missing indicator in row:', rowText.trim());

                            // Check if this missing assignment has been submitted (has paper emoji)
                            const hasSubmissionIndicator = rowText.includes('📄') ||
                                rowText.includes('This student has made a submission that has not been graded');

                            console.log(`Assignment "${assignmentName}" - Missing: true, Has submission indicator: ${hasSubmissionIndicator}`);

                            // Check if we already have this assignment in any category
                            const alreadyExists =
                                analysis.waitingForGrading.some(item => item.name === assignmentName && item.subject === subject) ||
                                analysis.missingSubmissions.some(item => item.name === assignmentName && item.subject === subject);

                            if (!alreadyExists) {
                                // Check if this is a practice assignment that should be ignored
                                const category = this.dataExtractor.extractCategory(row);
                                const assignmentObj = { name: assignmentName, subject: subject, category: category };
                                console.log(`DOM scanning found missing assignment: "${assignmentName}" in subject "${subject}" with category "${category}"`);
                                if (this.shouldIgnorePracticeAssignment(assignmentObj, grades)) {
                                    console.log(`Ignoring missing practice assignment "${assignmentName}" - course grade above threshold`);
                                    return;
                                }

                                if (hasSubmissionIndicator) {
                                    // Missing assignment that HAS been submitted - waiting for grading
                                    console.log('Adding submitted missing assignment (waiting for grading):', { assignmentName, subject });
                                    analysis.waitingForGrading.push({
                                        name: assignmentName,
                                        subject: subject || 'Unknown Subject',
                                        dueDate: null,
                                        status: 'waiting_for_grading'
                                    });
                                } else {
                                    // Missing assignment that has NOT been submitted - truly missing
                                    console.log('Adding truly missing assignment:', { assignmentName, subject });
                                    analysis.missingSubmissions.push({
                                        name: assignmentName,
                                        subject: subject || 'Unknown Subject',
                                        dueDate: null,
                                        status: 'missing'
                                    });
                                }
                            }
                        }
                    } catch (rowError) {
                        console.warn('Error processing row for assignment status:', rowError);
                    }
                });
            } catch (domError) {
                console.warn('Error in DOM assignment status detection:', domError);
            }

            // Update totals after DOM scanning
            analysis.hasMissingWork = analysis.missingSubmissions.length > 0 || analysis.lateSubmissions.length > 0;
            analysis.totalMissing = analysis.missingSubmissions.length;
            analysis.totalLate = analysis.lateSubmissions.length;
            analysis.totalWaiting = analysis.waitingForGrading.length;
            analysis.totalUpcoming = analysis.upcomingDueDates.length;

            console.log('Assignment status detection complete:', {
                missing: analysis.totalMissing,
                late: analysis.totalLate,
                waiting: analysis.totalWaiting,
                upcoming: analysis.totalUpcoming,
                hasMissingWork: analysis.hasMissingWork
            });

            return analysis;
        }

        /**
         * Create the main parent concerns dashboard panel (Task 4.1)
         * This replaces the simple test panel with a full-featured dashboard
         */
        createParentDashboard(grades, assignments, comments, commentAnalysis = null, gradeAnalysis = null, missingAssignments = null, upcomingAnalysis = null) {
            console.log('Creating parent concerns dashboard...');

            // Remove any existing dashboard
            const existingPanel = document.getElementById('schoology-parent-dashboard');
            if (existingPanel) {
                existingPanel.remove();
            }

            // Create the main dashboard container
            const dashboard = document.createElement('div');
            dashboard.id = 'schoology-parent-dashboard';

            // Apply Schoology-matching styles
            this.applyDashboardStyles(dashboard);

            // Build the dashboard content
            dashboard.innerHTML = this.buildDashboardHTML(grades, assignments, comments, commentAnalysis, gradeAnalysis, missingAssignments, upcomingAnalysis);

            // Add event listeners for interactivity
            this.attachDashboardEventListeners(dashboard);

            // Add smooth animations (Task 4.3)
            this.addDashboardAnimations(dashboard);

            // Position and add to page
            console.log('About to position dashboard...');
            this.positionDashboard(dashboard);
            console.log('Dashboard positioned');
            document.body.appendChild(dashboard);

            console.log('Parent concerns dashboard created and added to page');
            console.log('Dashboard element:', dashboard);
            console.log('Dashboard innerHTML length:', dashboard.innerHTML.length);
            console.log('Dashboard style:', dashboard.style.cssText);

            // Debug: Check if dashboard was actually added
            setTimeout(() => {
                const addedDashboard = document.getElementById('schoology-parent-dashboard');
                if (addedDashboard) {
                    console.log('✅ Dashboard found in DOM:', addedDashboard);
                    console.log('Dashboard computed style:', window.getComputedStyle(addedDashboard));
                    console.log('Dashboard position:', {
                        offsetTop: addedDashboard.offsetTop,
                        offsetLeft: addedDashboard.offsetLeft,
                        offsetWidth: addedDashboard.offsetWidth,
                        offsetHeight: addedDashboard.offsetHeight
                    });
                    console.log('Dashboard position:', addedDashboard.getBoundingClientRect());
                    console.log('Dashboard styles:', window.getComputedStyle(addedDashboard));
                } else {
                    console.log('❌ Dashboard NOT found in DOM - creating fallback');
                    this.createFallbackDashboard(grades, assignments, comments);
                }
            }, 100);

            return dashboard;
        }

        /**
         * Apply CSS styles that match Schoology's design patterns
         */
        applyDashboardStyles(dashboard) {
            dashboard.style.cssText = `
                position: fixed;
                top: 80px;
                right: 20px;
                width: 380px;
                background: #ffffff;
                border: 1px solid #d1d5da;
                border-radius: 6px;
                box-shadow: 0 8px 24px rgba(149, 157, 165, 0.2);
                z-index: 10000;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                font-size: 14px;
                line-height: 1.5;
                max-height: calc(100vh - 100px);
                overflow: hidden;
                transition: all 0.3s ease;
            `;
        }

        /**
         * Build the main dashboard HTML structure
         */
        buildDashboardHTML(grades, assignments, comments, commentAnalysis, gradeAnalysis, missingAssignments, upcomingAnalysis) {
            console.log('Building dashboard HTML with data:', {
                grades: grades?.length || 0,
                assignments: assignments?.length || 0,
                comments: comments?.length || 0,
                hasCommentAnalysis: !!commentAnalysis,
                hasGradeAnalysis: !!gradeAnalysis,
                hasMissingAssignments: !!missingAssignments,
                hasUpcomingAnalysis: !!upcomingAnalysis
            });

            try {
                const hasAnyConcerns = this.hasAnyConcerns(gradeAnalysis, missingAssignments, commentAnalysis, upcomingAnalysis);
                console.log('Has any concerns:', hasAnyConcerns);

                return `
                <div class="dashboard-header" style="
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 16px 20px;
                    border-radius: 6px 6px 0 0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                ">
                    <div>
                        <h2 style="margin: 0; font-size: 18px; font-weight: 600;">
                            🎓 Parent Dashboard
                        </h2>
                        <div style="font-size: 12px; opacity: 0.9; margin-top: 2px;">
                            ${hasAnyConcerns ? 'Attention needed' : 'All systems good'}
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button id="dashboard-settings" style="
                            background: rgba(255,255,255,0.2);
                            border: none;
                            color: white;
                            width: 28px;
                            height: 28px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 14px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        " title="Dashboard settings">⚙</button>
                        <button id="dashboard-minimize" style="
                            background: rgba(255,255,255,0.2);
                            border: none;
                            color: white;
                            width: 28px;
                            height: 28px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 14px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        " title="Minimize dashboard">−</button>
                        <button id="dashboard-close" style="
                            background: rgba(255,255,255,0.2);
                            border: none;
                            color: white;
                            width: 28px;
                            height: 28px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-size: 16px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        " title="Close dashboard">×</button>
                    </div>
                </div>
                
                <div class="dashboard-content" style="
                    padding: 0;
                    max-height: calc(100vh - 180px);
                    overflow-y: auto;
                ">
                    ${this.buildOverviewSection(grades, assignments, comments, gradeAnalysis, missingAssignments)}
                    ${this.configManager.get('showLowGrades') ? this.buildGradesConcernSection(gradeAnalysis) : ''}
                    ${this.configManager.get('showMissingAssignments') ? this.buildMissingWorkSection(missingAssignments) : ''}
                    ${this.configManager.get('showUpcomingAssignments') ? this.buildUpcomingAssignmentsSection(upcomingAnalysis) : ''}
                    ${this.configManager.get('showNegativeComments') ? this.buildCommentsConcernSection(commentAnalysis) : ''}
                    ${this.buildQuickStatsSection(gradeAnalysis, missingAssignments, commentAnalysis, upcomingAnalysis)}
                </div>
                
                <div class="dashboard-footer" style="
                    padding: 12px 20px;
                    border-top: 1px solid #e1e4e8;
                    background: #f6f8fa;
                    border-radius: 0 0 6px 6px;
                    font-size: 11px;
                    color: #586069;
                    text-align: center;
                ">
                    <div>🔄 Updates automatically • Schoology Parent Dashboard v1.0</div>
                </div>
            `;

            } catch (error) {
                console.error('Error in buildDashboardHTML:', error);
                return `
                    <div style="padding: 20px; text-align: center; color: #dc2626;">
                        <div style="font-weight: bold; margin-bottom: 10px;">⚠️ Error Building Dashboard</div>
                        <div style="font-size: 12px;">Check console for details</div>
                        <div style="font-size: 11px; margin-top: 8px; color: #666;">
                            Error: ${error.message}
                        </div>
                    </div>
                `;
            }
        }

        /**
         * Check if there are any concerns to highlight in the header
         */
        hasAnyConcerns(gradeAnalysis, missingAssignments, commentAnalysis, upcomingAnalysis) {
            return (gradeAnalysis && gradeAnalysis.concerningGrades && gradeAnalysis.concerningGrades.length > 0) ||
                (missingAssignments && missingAssignments.hasMissingWork) ||
                (commentAnalysis && commentAnalysis.hasNegativeComments) ||
                (upcomingAnalysis && upcomingAnalysis.hasHighWorkload);
        }

        /**
         * Get the correct assignment count
         */
        getAssignmentCount(assignments, missingAssignments) {
            return missingAssignments && missingAssignments.totalAssignments !== undefined
                ? missingAssignments.totalAssignments
                : assignments.length;
        }

        /**
         * Build the overview section showing data extraction status
         */
        buildOverviewSection(grades, assignments, comments, gradeAnalysis, missingAssignments) {
            return `
                <div style="padding: 16px 20px; border-bottom: 1px solid #e1e4e8;">
                    <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #24292e;">
                        📊 Data Overview
                        ${this.currentMarkingPeriod && this.currentMarkingPeriod !== 'current' ?
                    `<span style="font-size: 11px; font-weight: 400; color: #6b7280; margin-left: 8px;">(${this.currentMarkingPeriod})</span>` :
                    ''}
                    </h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; font-size: 12px;">
                        <div style="text-align: center; padding: 8px; background: #f0f9ff; border-radius: 4px; border: 1px solid #bae6fd;">
                            <div style="font-weight: 600; color: #0369a1;">${gradeAnalysis && gradeAnalysis.totalGrades !== undefined ? gradeAnalysis.totalGrades : grades.filter(g => g.grade && g.grade !== null && g.grade !== 'Exempt').length}</div>
                            <div style="color: #0c4a6e;">Grades</div>
                        </div>
                        <div style="text-align: center; padding: 8px; background: #f0fdf4; border-radius: 4px; border: 1px solid #bbf7d0;">
                            <div style="font-weight: 600; color: #059669;">${this.getAssignmentCount(assignments, missingAssignments)}</div>
                            <div style="color: #047857;">Assignments</div>
                        </div>
                        <div style="text-align: center; padding: 8px; background: #fefce8; border-radius: 4px; border: 1px solid #fde047;">
                            <div style="font-weight: 600; color: #ca8a04;">${comments.length}</div>
                            <div style="color: #a16207;">Comments</div>
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Build the grades concern section with enhanced individual concern rendering (Task 4.2)
         */
        buildGradesConcernSection(gradeAnalysis) {
            if (!gradeAnalysis || !gradeAnalysis.hasGrades) {
                return this.renderEmptySection('📈 Grade Performance', 'No grade data available');
            }

            const concerningGrades = gradeAnalysis.concerningGrades || [];
            const hasIssues = concerningGrades.length > 0;
            const statusColor = gradeAnalysis.performanceLevel === 'excellent' ? '#059669' :
                gradeAnalysis.performanceLevel === 'good' ? '#d97706' : '#dc2626';
            const bgColor = gradeAnalysis.performanceLevel === 'excellent' ? '#f0fdf4' :
                gradeAnalysis.performanceLevel === 'good' ? '#fffbeb' : '#fef2f2';

            return `
                <div style="padding: 16px 20px; border-bottom: 1px solid #e1e4e8;">
                    ${this.renderSectionHeader('📈 Grade Performance', concerningGrades.length)}
                    
                    <div class="section-summary" style="background: ${bgColor}; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span style="font-weight: 600; color: ${statusColor};">
                                ${gradeAnalysis.performanceLevel === 'excellent' ? '🌟 Excellent' :
                    gradeAnalysis.performanceLevel === 'good' ? '👍 Good' : '⚠️ Needs Attention'}
                            </span>
                            ${gradeAnalysis.averageGrade ? `<span style="font-weight: 600; color: ${statusColor};">${gradeAnalysis.averageGrade}% avg</span>` : ''}
                        </div>
                        
                        <div class="section-summary-content">
                            ${this.renderGradeBreakdown(gradeAnalysis.gradeBreakdown)}
                        </div>
                        
                        <div class="section-collapsible-content">
                            ${hasIssues ?
                    this.renderAllConcerningGrades(concerningGrades) :
                    this.renderSuccessMessage('All grades are performing well', statusColor)
                }
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Render all concerning grades in a simplified format (Task 4.2)
         */
        renderAllConcerningGrades(concerningGrades) {
            if (!concerningGrades || !Array.isArray(concerningGrades)) {
                return '<div style="color: #6b7280; font-size: 12px;">No concerning grades data available</div>';
            }

            return `
                <div style="margin-top: 8px;">
                    <div style="font-size: 12px; font-weight: 600; color: #dc2626; margin-bottom: 6px;">
                        Grades needing attention:
                    </div>
                    ${concerningGrades.map(grade => this.renderGradeConcernItem(grade)).join('')}
                </div>
            `;
        }

        /**
         * Render individual grade concern item template (Task 4.2)
         */
        renderGradeConcernItem(grade) {
            const gradeDisplay = typeof grade.grade === 'object' ?
                `${grade.grade.letter} (${grade.grade.earned}/${grade.grade.total})` :
                grade.grade;

            const severityColor = grade.concern.includes('Failing') ? '#dc2626' :
                grade.concern.includes('Poor') ? '#ea580c' : '#d97706';

            return `
                <div style="
                    margin: 4px 0; 
                    padding: 8px; 
                    background: rgba(220, 38, 38, 0.05); 
                    border-left: 3px solid ${severityColor}; 
                    border-radius: 0 4px 4px 0;
                    font-size: 11px;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                        <span style="font-weight: 600; color: #374151;">${grade.assignment}</span>
                        <span style="font-weight: 600; color: ${severityColor};">${gradeDisplay}</span>
                    </div>
                    <div style="color: #6b7280; font-size: 10px;">
                        ${grade.subject} • ${grade.concern}
                    </div>
                </div>
            `;
        }



        /**
         * Build the missing work section with enhanced individual concern rendering (Task 4.2)
         */
        buildMissingWorkSection(missingAssignments) {
            if (!missingAssignments) {
                return '';
            }

            // Count missing, late, and waiting assignments
            const actualMissingWork = (missingAssignments.totalMissing || 0) + (missingAssignments.totalLate || 0) > 0;
            const hasWaitingWork = (missingAssignments.totalWaiting || 0) > 0;
            const totalConcerns = (missingAssignments.totalMissing || 0) + (missingAssignments.totalLate || 0);
            const hasAnyWork = actualMissingWork || hasWaitingWork;

            return `
                <div style="padding: 16px 20px; border-bottom: 1px solid #e1e4e8;">
                    ${this.renderSectionHeader('📋 Assignment Status', totalConcerns)}
                    
                    ${actualMissingWork ? `
                        <div class="section-summary" style="background: #fef2f2; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                            <div style="font-weight: 600; color: #dc2626; margin-bottom: 8px;">
                                ⚠️ Missing Work Detected
                            </div>
                            
                            <div class="section-summary-content">
                                ${this.renderMissingWorkSummary(missingAssignments)}
                            </div>
                            
                            <div class="section-collapsible-content">
                                ${this.renderMissingWorkDetails(missingAssignments)}
                            </div>
                        </div>
                    ` : ''}
                    
                    ${hasWaitingWork ? `
                        <div class="section-summary" style="background: #fefce8; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                            <div style="font-weight: 600; color: #ca8a04; margin-bottom: 8px;">
                                ⏳ Waiting for Grading
                            </div>
                            <div style="font-size: 12px; color: #92400e; margin-bottom: 8px;">
                                Missing assignments that have been submitted but not yet graded
                            </div>
                            
                            <div class="section-summary-content">
                                ${this.renderWaitingWorkSummary(missingAssignments)}
                            </div>
                            
                            <div class="section-collapsible-content">
                                ${this.renderWaitingWorkDetails(missingAssignments)}
                            </div>
                        </div>
                    ` : ''}
                    
                    ${!hasAnyWork ? `
                        <div class="section-summary" style="background: #f0fdf4; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                            <div style="font-weight: 600; color: #059669; margin-bottom: 8px;">
                                ✅ No Missing Work
                            </div>
                            <div style="font-size: 12px; color: #047857;">All assignments are up to date</div>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render missing work summary with counts (Task 4.2)
         */
        renderMissingWorkSummary(missingAssignments) {
            if (!missingAssignments) {
                return '';
            }

            // Extract unique course names from missing and late assignments
            const missingSubmissions = missingAssignments.missingSubmissions || [];
            const lateSubmissions = missingAssignments.lateSubmissions || [];
            const allItems = [...missingSubmissions, ...lateSubmissions];

            const uniqueCourses = [...new Set(allItems.map(item => item.subject).filter(subject => subject && subject !== 'Unknown Subject'))];
            const totalMissing = (missingAssignments.totalMissing || 0);
            const totalLate = (missingAssignments.totalLate || 0);
            const totalConcerns = totalMissing + totalLate;

            if (totalConcerns === 0) {
                return '';
            }

            return `
                <div style="display: flex; gap: 12px; font-size: 12px;">
                    <!-- Left 25% - Missing Count -->
                    <div style="flex: 0 0 25%; display: flex; flex-direction: column; gap: 4px;">
                        ${totalMissing > 0 ? `
                            <div style="text-align: center; padding: 6px; background: rgba(220, 38, 38, 0.1); border-radius: 4px;">
                                <div style="font-weight: 600; color: #dc2626;">${totalMissing}</div>
                                <div style="color: #7f1d1d; font-size: 10px;">Missing</div>
                            </div>
                        ` : ''}
                        
                        ${totalLate > 0 ? `
                            <div style="text-align: center; padding: 6px; background: rgba(234, 88, 12, 0.1); border-radius: 4px;">
                                <div style="font-weight: 600; color: #ea580c;">${totalLate}</div>
                                <div style="color: #9a3412; font-size: 10px;">Late</div>
                            </div>
                        ` : ''}
                    </div>
                    
                    <!-- Right 75% - Course Names -->
                    <div style="flex: 1; padding: 6px; background: rgba(107, 114, 128, 0.05); border-radius: 4px;">
                        <div style="color: #6b7280; font-size: 10px; line-height: 1.4;">
                            ${uniqueCourses.length > 0 ?
                    uniqueCourses.map(course => {
                        // Clean up course name for display
                        let cleanName = course
                            .replace(/Course$/, '')                    // Remove "Course" suffix
                            .replace(/Hon \([AB]\):\s*/, '')          // Remove "Hon (A):" or "Hon (B):"
                            .replace(/\s+Sec \d+\s*[AB]?\s*/, '')     // Remove " Sec 901 B" or " Sec 001 A"
                            .replace(/:\s*Sec \d+\s*[AB]?\s*/, '')    // Remove ": Sec 001 A" (with colon)
                            .replace(/\s*PER\d+\s*/, '')              // Remove "PER01", "PER02", etc.
                            .replace(/\s*\([AB]\):?\s*/, '')          // Remove " (A):" or " (B):" or " (A)" or " (B)"
                            .replace(/:+$/, '')                       // Remove trailing colons
                            .replace(/\s+/g, ' ')                     // Normalize whitespace
                            .trim();
                        return `<div>${cleanName}</div>`;
                    }).join('')
                    : '<div>Multiple courses</div>'
                }
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Render waiting work summary with counts
         */
        renderWaitingWorkSummary(missingAssignments) {
            if (!missingAssignments || !missingAssignments.waitingForGrading) {
                return '';
            }

            const waitingSubmissions = missingAssignments.waitingForGrading || [];
            const uniqueCourses = [...new Set(waitingSubmissions.map(item => item.subject).filter(subject => subject && subject !== 'Unknown Subject'))];
            const totalWaiting = waitingSubmissions.length;

            if (totalWaiting === 0) {
                return '';
            }

            return `
                <div style="display: flex; gap: 12px; font-size: 12px;">
                    <!-- Left 25% - Waiting Count -->
                    <div style="flex: 0 0 25%; display: flex; flex-direction: column; gap: 4px;">
                        <div style="text-align: center; padding: 6px; background: rgba(202, 138, 4, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #ca8a04;">${totalWaiting}</div>
                            <div style="color: #92400e; font-size: 10px;">Waiting</div>
                        </div>
                    </div>
                    
                    <!-- Right 75% - Course Names -->
                    <div style="flex: 1; padding: 6px; background: rgba(107, 114, 128, 0.05); border-radius: 4px;">
                        <div style="color: #6b7280; font-size: 10px; line-height: 1.4;">
                            ${uniqueCourses.length > 0 ?
                    uniqueCourses.map(course => {
                        // Clean up course name for display
                        let cleanName = course
                            .replace(/Course$/, '')
                            .replace(/Hon \([AB]\):\s*/, '')
                            .replace(/\s+Sec \d+\s*[AB]?\s*/, '')
                            .replace(/:\s*Sec \d+\s*[AB]?\s*/, '')
                            .replace(/\s*PER\d+\s*/, '')
                            .replace(/\s*\([AB]\):?\s*/, '')
                            .replace(/:+$/, '')
                            .replace(/\s+/g, ' ')
                            .trim();
                        return `<div>${cleanName}</div>`;
                    }).join('')
                    : '<div>Multiple courses</div>'
                }
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Render detailed waiting work items
         */
        renderWaitingWorkDetails(missingAssignments) {
            if (!missingAssignments || !missingAssignments.waitingForGrading) {
                return '';
            }

            const waitingSubmissions = missingAssignments.waitingForGrading || [];

            if (waitingSubmissions.length === 0) return '';

            return `
                <div style="margin-top: 8px;">
                    <div style="font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 8px;">
                        Submitted Assignments:
                    </div>
                    <div class="assignment-list-visible">
                        ${waitingSubmissions.slice(0, 5).map(item => this.renderWaitingWorkItem(item)).join('')}
                    </div>
                    ${waitingSubmissions.length > 5 ? `
                        <div class="assignment-list-hidden" style="display: none;">
                            ${waitingSubmissions.slice(5).map(item => this.renderWaitingWorkItem(item)).join('')}
                        </div>
                        <button class="show-more-assignments" style="
                            background: none; 
                            border: none; 
                            color: #ca8a04; 
                            font-size: 11px; 
                            cursor: pointer; 
                            text-decoration: underline;
                            padding: 4px 0;
                            margin-top: 4px;
                        ">
                            Show ${waitingSubmissions.length - 5} more assignment${waitingSubmissions.length - 5 > 1 ? 's' : ''}
                        </button>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render individual waiting work item template
         */
        renderWaitingWorkItem(item) {
            return `
                <div style="
                    margin: 4px 0; 
                    padding: 8px; 
                    background: rgba(202, 138, 4, 0.05); 
                    border-left: 3px solid #ca8a04; 
                    border-radius: 0 4px 4px 0;
                    font-size: 11px;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                        <span style="font-weight: 600; color: #374151;">${item.name}</span>
                        <span style="font-weight: 600; color: #ca8a04;">📄 Waiting</span>
                    </div>
                    <div style="color: #6b7280; font-size: 10px;">
                        ${item.subject} • Was missing, now submitted and awaiting grading
                    </div>
                </div>
            `;
        }

        /**
         * Render detailed missing work items (Task 4.2)
         */
        renderMissingWorkDetails(missingAssignments) {
            if (!missingAssignments) {
                return '';
            }

            const missingSubmissions = missingAssignments.missingSubmissions || [];
            const lateSubmissions = missingAssignments.lateSubmissions || [];
            const upcomingDueDates = missingAssignments.upcomingDueDates || [];

            const allItems = [
                ...missingSubmissions.map(item => ({ ...item, type: 'missing' })),
                ...lateSubmissions.map(item => ({ ...item, type: 'late' }))
                // Removed upcomingDueDates - these belong in Upcoming Assignments section
            ];

            if (allItems.length === 0) return '';

            return `
                <div style="margin-top: 8px;">
                    <div style="font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 8px;">
                        Assignment Details:
                    </div>
                    <div class="assignment-list-visible">
                        ${allItems.slice(0, 5).map(item => this.renderMissingWorkItem(item)).join('')}
                    </div>
                    ${allItems.length > 5 ? `
                        <div class="assignment-list-hidden" style="display: none;">
                            ${allItems.slice(5).map(item => this.renderMissingWorkItem(item)).join('')}
                        </div>
                        <button class="show-more-assignments" style="
                            background: none; 
                            border: none; 
                            color: #dc2626; 
                            font-size: 11px; 
                            cursor: pointer; 
                            text-decoration: underline;
                            padding: 4px 0;
                            margin-top: 4px;
                        ">
                            Show ${allItems.length - 5} more assignment${allItems.length - 5 > 1 ? 's' : ''}
                        </button>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render individual missing work item template (Task 4.2)
         */
        renderMissingWorkItem(item) {
            const typeConfig = {
                missing: { icon: '❌', color: '#dc2626', bgColor: 'rgba(220, 38, 38, 0.05)', label: 'Missing' },
                late: { icon: '⏰', color: '#ea580c', bgColor: 'rgba(234, 88, 12, 0.05)', label: 'Late' },
                upcoming: { icon: '📅', color: '#d97706', bgColor: 'rgba(217, 119, 6, 0.05)', label: 'Due Soon' }
            };

            const config = typeConfig[item.type];
            const dueText = item.dueDate ? new Date(item.dueDate).toLocaleDateString() : 'No due date';
            const urgencyText = item.daysUntilDue !== undefined ? `${item.daysUntilDue} day${item.daysUntilDue !== 1 ? 's' : ''}` : '';

            return `
                <div style="
                    margin: 4px 0; 
                    padding: 8px; 
                    background: ${config.bgColor}; 
                    border-left: 3px solid ${config.color}; 
                    border-radius: 0 4px 4px 0;
                    font-size: 11px;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
                        <span style="font-weight: 600; color: #374151;">${item.name}</span>
                        <span style="font-weight: 600; color: ${config.color};">${config.icon} ${config.label}</span>
                    </div>
                    <div style="color: #6b7280; font-size: 10px;">
                        ${item.subject} • Due: ${dueText} ${urgencyText ? `• ${urgencyText}` : ''}
                    </div>
                </div>
            `;
        }

        /**
         * Build the upcoming assignments section (Task 3.4)
         */
        buildUpcomingAssignmentsSection(upcomingAnalysis) {
            if (!upcomingAnalysis || upcomingAnalysis.totalUpcoming === 0) {
                const upcomingWindow = this.configManager.getUpcomingDaysWindow();
                return this.renderEmptySection('📅 Upcoming Assignments', `No upcoming assignments in the next ${upcomingWindow} days`);
            }

            const hasHighWorkload = upcomingAnalysis.hasHighWorkload;
            const urgentAssignments = upcomingAnalysis.urgentAssignments || [];
            const majorAssignments = upcomingAnalysis.majorAssignments || [];
            const urgentCount = urgentAssignments.length;
            const majorCount = majorAssignments.length;

            return `
                <div style="padding: 16px 20px; border-bottom: 1px solid #e1e4e8;">
                    ${this.renderSectionHeader('📅 Upcoming Assignments', urgentCount)}
                    
                    <div class="section-summary" style="background: ${hasHighWorkload ? '#fef2f2' : '#f0fdf4'}; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                        <div style="font-weight: 600; color: ${hasHighWorkload ? '#dc2626' : '#059669'}; margin-bottom: 8px;">
                            ${hasHighWorkload ? '⚠️ High Workload Detected' : '📋 Manageable Workload'}
                        </div>
                        
                        <div class="section-summary-content">
                            ${hasHighWorkload ?
                    this.renderWorkloadSummary(upcomingAnalysis) :
                    `<div style="font-size: 12px; color: #047857;">${upcomingAnalysis.totalUpcoming} assignment${upcomingAnalysis.totalUpcoming !== 1 ? 's' : ''} in the next ${this.configManager.getUpcomingDaysWindow()} days</div>`
                }
                        </div>
                        
                        <div class="section-collapsible-content">
                            ${this.renderUpcomingAssignmentDetails(upcomingAnalysis)}
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Render workload summary for high workload situations (Task 3.4)
         */
        renderWorkloadSummary(upcomingAnalysis) {
            if (!upcomingAnalysis) {
                return '';
            }

            const urgentAssignments = upcomingAnalysis.urgentAssignments || [];
            const majorAssignments = upcomingAnalysis.majorAssignments || [];
            const urgentCount = urgentAssignments.length;
            const majorCount = majorAssignments.length;

            return `
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; font-size: 12px;">
                    ${(upcomingAnalysis.nextWeekWorkload || 0) > 0 ? `
                        <div style="text-align: center; padding: 6px; background: rgba(220, 38, 38, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #dc2626;">${upcomingAnalysis.nextWeekWorkload}</div>
                            <div style="color: #7f1d1d; font-size: 10px;">Next Week</div>
                        </div>
                    ` : ''}
                    
                    ${urgentCount > 0 ? `
                        <div style="text-align: center; padding: 6px; background: rgba(234, 88, 12, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #ea580c;">${urgentCount}</div>
                            <div style="color: #9a3412; font-size: 10px;">Urgent</div>
                        </div>
                    ` : ''}
                    
                    ${majorCount > 0 ? `
                        <div style="text-align: center; padding: 6px; background: rgba(217, 119, 6, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #d97706;">${majorCount}</div>
                            <div style="color: #92400e; font-size: 10px;">Major</div>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render detailed upcoming assignment items (Task 3.4)
         */
        renderUpcomingAssignmentDetails(upcomingAnalysis) {
            if (!upcomingAnalysis) {
                return '';
            }

            const upcomingAssignments = upcomingAnalysis.upcomingAssignments || [];
            const topAssignments = upcomingAssignments.slice(0, 5);

            if (topAssignments.length === 0) return '';

            return `
                <div style="margin-top: 8px;">
                    <div style="font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 8px;">
                        Priority Assignments:
                    </div>
                    ${topAssignments.map(assignment => this.renderUpcomingAssignmentItem(assignment)).join('')}
                    ${upcomingAnalysis.upcomingAssignments.length > 5 ? `
                        <button class="show-more-upcoming" style="
                            background: none; 
                            border: none; 
                            color: #059669; 
                            font-size: 11px; 
                            cursor: pointer; 
                            text-decoration: underline;
                            padding: 4px 0;
                            margin-top: 4px;
                        ">
                            Show ${upcomingAnalysis.upcomingAssignments.length - 5} more assignment${upcomingAnalysis.upcomingAssignments.length - 5 > 1 ? 's' : ''}
                        </button>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render individual upcoming assignment item (Task 3.4)
         */
        renderUpcomingAssignmentItem(assignment) {
            const priorityConfig = {
                urgent: { icon: '🔴', color: '#dc2626', bgColor: 'rgba(220, 38, 38, 0.05)', label: 'URGENT' },
                high: { icon: '🟠', color: '#ea580c', bgColor: 'rgba(234, 88, 12, 0.05)', label: 'HIGH' },
                medium: { icon: '🟡', color: '#d97706', bgColor: 'rgba(217, 119, 6, 0.05)', label: 'MEDIUM' },
                low: { icon: '🟢', color: '#059669', bgColor: 'rgba(5, 150, 105, 0.05)', label: 'LOW' }
            };

            const config = priorityConfig[assignment.priority] || priorityConfig.medium;
            const dueText = new Date(assignment.dueDate).toLocaleDateString();
            const dayText = assignment.daysUntilDue === 1 ? '1 day' : `${assignment.daysUntilDue} days`;

            // Performance indicator
            const perfIndicator = assignment.subjectPerformance.level === 'struggling' ? '⚠️' :
                assignment.subjectPerformance.level === 'needs_attention' ? '⚡' :
                    assignment.subjectPerformance.level === 'excellent' ? '⭐' : '';

            return `
                <div style="
                    margin: 4px 0; 
                    padding: 10px; 
                    background: ${config.bgColor}; 
                    border-left: 3px solid ${config.color}; 
                    border-radius: 0 6px 6px 0;
                    font-size: 11px;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <span style="font-weight: 600; color: #374151;">
                            ${assignment.name} ${assignment.isMajor ? '📋' : ''} ${perfIndicator}
                        </span>
                        <span style="font-weight: 600; color: ${config.color};">${config.icon} ${config.label}</span>
                    </div>
                    <div style="color: #6b7280; font-size: 10px; margin: 2px 0;">
                        ${assignment.subject} • Due: ${dueText} (${dayText})
                    </div>
                    <div style="color: #6b7280; font-size: 10px;">
                        Workload: ${assignment.estimatedWorkload} ${assignment.subjectPerformance.average ? `• Subject avg: ${assignment.subjectPerformance.average}%` : ''}
                    </div>
                </div>
            `;
        }

        /**
         * Build the teacher comments concern section with enhanced individual rendering (Task 4.2)
         */
        buildCommentsConcernSection(commentAnalysis) {
            if (!commentAnalysis) {
                return '';
            }

            const hasNegativeComments = commentAnalysis.hasNegativeComments;

            return `
                <div style="padding: 16px 20px; border-bottom: 1px solid #e1e4e8;">
                    ${this.renderSectionHeader('💬 Teacher Feedback', commentAnalysis.negativeCount)}
                    
                    <div class="section-summary" style="background: ${hasNegativeComments ? '#fef2f2' : '#f0fdf4'}; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                        <div style="font-weight: 600; color: ${hasNegativeComments ? '#dc2626' : '#059669'}; margin-bottom: 8px;">
                            ${hasNegativeComments ? '⚠️ Concerning Comments Found' : '✅ Positive Feedback'}
                        </div>
                        
                        <div class="section-summary-content">
                            ${hasNegativeComments ?
                    this.renderCommentSeverityBreakdown(commentAnalysis.severityBreakdown) :
                    `<div style="font-size: 12px; color: #047857;">${commentAnalysis.totalComments > 0 ? `${commentAnalysis.positiveCount} positive comment${commentAnalysis.positiveCount !== 1 ? 's' : ''} found` : 'No concerning teacher feedback'}</div>`
                }
                        </div>
                        
                        <div class="section-collapsible-content">
                            ${hasNegativeComments ? this.renderCommentDetails(commentAnalysis.negativeComments) : ''}
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Render comment severity breakdown (Task 4.2)
         */
        renderCommentSeverityBreakdown(severityBreakdown) {
            return `
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(80px, 1fr)); gap: 8px; font-size: 12px;">
                    ${severityBreakdown.high > 0 ? `
                        <div style="text-align: center; padding: 6px; background: rgba(220, 38, 38, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #dc2626;">${severityBreakdown.high}</div>
                            <div style="color: #7f1d1d; font-size: 10px;">High</div>
                        </div>
                    ` : ''}
                    
                    ${severityBreakdown.medium > 0 ? `
                        <div style="text-align: center; padding: 6px; background: rgba(234, 88, 12, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #ea580c;">${severityBreakdown.medium}</div>
                            <div style="color: #9a3412; font-size: 10px;">Medium</div>
                        </div>
                    ` : ''}
                    
                    ${severityBreakdown.low > 0 ? `
                        <div style="text-align: center; padding: 6px; background: rgba(217, 119, 6, 0.1); border-radius: 4px;">
                            <div style="font-weight: 600; color: #d97706;">${severityBreakdown.low}</div>
                            <div style="color: #92400e; font-size: 10px;">Low</div>
                        </div>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render detailed comment items (Task 4.2)
         */
        renderCommentDetails(negativeComments) {
            if (negativeComments.length === 0) return '';

            return `
                <div style="margin-top: 8px;">
                    <div style="font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 8px;">
                        Concerning Comments:
                    </div>
                    ${negativeComments.slice(0, 3).map(comment => this.renderCommentItem(comment)).join('')}
                    ${negativeComments.length > 3 ? `
                        <button class="show-more-comments" style="
                            background: none; 
                            border: none; 
                            color: #dc2626; 
                            font-size: 11px; 
                            cursor: pointer; 
                            text-decoration: underline;
                            padding: 4px 0;
                            margin-top: 4px;
                        ">
                            Show ${negativeComments.length - 3} more comment${negativeComments.length - 3 > 1 ? 's' : ''}
                        </button>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render individual comment item template (Task 4.2)
         */
        renderCommentItem(comment) {
            const severityConfig = {
                high: { color: '#dc2626', bgColor: 'rgba(220, 38, 38, 0.05)', icon: '🔴' },
                medium: { color: '#ea580c', bgColor: 'rgba(234, 88, 12, 0.05)', icon: '🟡' },
                low: { color: '#d97706', bgColor: 'rgba(217, 119, 6, 0.05)', icon: '🟠' }
            };

            const config = severityConfig[comment.severity] || severityConfig.low;
            const displayText = comment.truncatedComment || comment.fullComment || comment.comment || 'No comment text';
            const assignmentName = comment.assignmentName !== 'Unknown Assignment' ? comment.assignmentName : 'Assignment';
            const teacherName = comment.teacher || 'Teacher';
            const dateText = comment.date ? new Date(comment.date).toLocaleDateString() : '';

            return `
                <div style="
                    margin: 4px 0; 
                    padding: 10px; 
                    background: ${config.bgColor}; 
                    border-left: 3px solid ${config.color}; 
                    border-radius: 0 6px 6px 0;
                    font-size: 11px;
                ">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <span style="font-weight: 600; color: #374151;">${assignmentName}</span>
                        <span style="font-weight: 600; color: ${config.color};">${config.icon} ${comment.severity.toUpperCase()}</span>
                    </div>
                    <div style="color: #4b5563; font-style: italic; margin: 4px 0; line-height: 1.3;">
                        "${displayText}"
                    </div>
                    <div style="color: #6b7280; font-size: 10px;">
                        ${teacherName} ${dateText ? `• ${dateText}` : ''} • Score: ${comment.negativeScore}/${comment.positiveScore}
                    </div>
                </div>
            `;
        }

        /**
         * Build the quick stats section
         */
        buildQuickStatsSection(gradeAnalysis, missingAssignments, commentAnalysis, upcomingAnalysis) {
            return `
                <div style="padding: 16px 20px;">
                    <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #24292e;">
                        📈 Quick Stats
                    </h3>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px;">
                        <div style="background: #f8fafc; padding: 8px; border-radius: 4px; text-align: center;">
                            <div style="font-weight: 600; color: #1e293b;">
                                ${gradeAnalysis && gradeAnalysis.subjectCount || 0}
                            </div>
                            <div style="color: #64748b;">Subjects</div>
                        </div>
                        
                        <div style="background: #f8fafc; padding: 8px; border-radius: 4px; text-align: center;">
                            <div style="font-weight: 600; color: #1e293b;">
                                ${gradeAnalysis && gradeAnalysis.totalGrades || 0}
                            </div>
                            <div style="color: #64748b;">Total Grades</div>
                        </div>
                        
                        <div style="background: #f8fafc; padding: 8px; border-radius: 4px; text-align: center;">
                            <div style="font-weight: 600; color: #1e293b;">
                                ${commentAnalysis && commentAnalysis.totalComments || 0}
                            </div>
                            <div style="color: #64748b;">Comments</div>
                        </div>
                        
                        <div style="background: #f8fafc; padding: 8px; border-radius: 4px; text-align: center;">
                            <div style="font-weight: 600; color: #1e293b;">
                                ${upcomingAnalysis && upcomingAnalysis.totalUpcoming || 0}
                            </div>
                            <div style="color: #64748b;">Upcoming</div>
                        </div>
                    </div>
                </div>
            `;
        }

        /**
         * Attach event listeners for dashboard interactivity (Enhanced for Task 4.2 & 4.3)
         */
        attachDashboardEventListeners(dashboard) {
            // Close button
            const closeBtn = dashboard.querySelector('#dashboard-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    dashboard.remove();
                });
            }

            // Settings button
            const settingsBtn = dashboard.querySelector('#dashboard-settings');
            if (settingsBtn) {
                settingsBtn.addEventListener('click', () => {
                    this.configUI.show();
                });
            }

            // Minimize button (Task 4.3)
            const minimizeBtn = dashboard.querySelector('#dashboard-minimize');
            if (minimizeBtn) {
                minimizeBtn.addEventListener('click', () => {
                    this.toggleDashboardMinimize(dashboard);
                });
            }

            // Hover effects for buttons
            [closeBtn, settingsBtn, minimizeBtn].forEach(btn => {
                if (btn) {
                    btn.addEventListener('mouseenter', () => {
                        btn.style.background = 'rgba(255,255,255,0.3)';
                    });
                    btn.addEventListener('mouseleave', () => {
                        btn.style.background = 'rgba(255,255,255,0.2)';
                    });
                }
            });

            // Show more buttons for expandable content (Task 4.2)
            this.attachShowMoreListeners(dashboard);

            // Section collapse/expand functionality (Task 4.3)
            this.attachSectionToggleListeners(dashboard);
        }

        /**
         * Attach listeners for "show more" expandable content (Task 4.2)
         */
        attachShowMoreListeners(dashboard) {
            // Note: Show more grades functionality removed - now using section collapse instead

            // Show more assignments
            const showMoreAssignments = dashboard.querySelector('.show-more-assignments');
            if (showMoreAssignments) {
                showMoreAssignments.addEventListener('click', () => {
                    this.toggleExpandableList(dashboard, 'assignments', showMoreAssignments);
                });
            }

            // Show more comments
            const showMoreComments = dashboard.querySelector('.show-more-comments');
            if (showMoreComments) {
                showMoreComments.addEventListener('click', () => {
                    this.toggleExpandableList(dashboard, 'comments', showMoreComments);
                });
            }

            // Show more upcoming assignments
            const showMoreUpcoming = dashboard.querySelector('.show-more-upcoming');
            if (showMoreUpcoming) {
                showMoreUpcoming.addEventListener('click', () => {
                    this.toggleExpandableList(dashboard, 'upcoming', showMoreUpcoming);
                });
            }
        }

        /**
         * Attach listeners for section collapse/expand (Task 4.3)
         */
        attachSectionToggleListeners(dashboard) {
            // Add click listeners to section headers for collapse/expand
            const sectionHeaders = dashboard.querySelectorAll('.section-header');
            sectionHeaders.forEach(headerDiv => {
                headerDiv.addEventListener('click', () => {
                    // Find the parent section (the div containing this header)
                    const section = headerDiv.closest('div[style*="padding: 16px 20px"]');
                    if (section) {
                        this.toggleSectionCollapse(section);
                    }
                });
            });

            // Apply default collapsed state if configured
            if (!this.configManager.get('sectionsDefaultExpanded')) {
                sectionHeaders.forEach(headerDiv => {
                    const section = headerDiv.closest('div[style*="padding: 16px 20px"]');
                    if (section) {
                        // Collapse the section by default
                        this.collapseSectionByDefault(section);
                    }
                });
            }
        }

        /**
         * Collapse a section by default (used for initial state)
         */
        collapseSectionByDefault(section) {
            const indicator = section.querySelector('.collapse-indicator');
            const collapsibleElements = section.querySelectorAll('.section-collapsible-content');

            // Hide collapsible content
            collapsibleElements.forEach(element => {
                element.style.display = 'none';
            });

            // Update indicator to collapsed state
            if (indicator) {
                indicator.style.transform = 'rotate(-90deg)';
                indicator.textContent = '▶';
            }
        }

        /**
         * Toggle expandable list visibility (Task 4.2)
         */
        toggleExpandableList(dashboard, type, button) {
            if (type === 'assignments') {
                // Find the hidden assignment list
                const hiddenList = button.parentElement.querySelector('.assignment-list-hidden');
                if (hiddenList) {
                    const isCurrentlyHidden = hiddenList.style.display === 'none';

                    if (isCurrentlyHidden) {
                        // Show hidden assignments
                        hiddenList.style.display = 'block';
                        button.textContent = button.textContent.replace('Show', 'Hide');
                    } else {
                        // Hide assignments
                        hiddenList.style.display = 'none';
                        button.textContent = button.textContent.replace('Hide', 'Show');
                    }
                }
            } else {
                // Placeholder for other types (comments, upcoming)
                const isExpanded = button.textContent.includes('Hide');
                button.textContent = isExpanded ?
                    button.textContent.replace('Hide', 'Show') :
                    button.textContent.replace('Show', 'Hide');
            }
        }

        /**
         * Toggle section collapse/expand state (Task 4.3)
         */
        toggleSectionCollapse(section) {
            const indicator = section.querySelector('.collapse-indicator');

            // Find only the collapsible content elements
            const collapsibleElements = section.querySelectorAll('.section-collapsible-content');

            // Check current state by looking at the first collapsible element
            const isCurrentlyCollapsed = collapsibleElements.length > 0 &&
                collapsibleElements[0].style.display === 'none';

            // Toggle visibility of collapsible content elements only
            collapsibleElements.forEach(element => {
                if (isCurrentlyCollapsed) {
                    element.style.display = '';
                } else {
                    element.style.display = 'none';
                }
            });

            // Update indicator
            if (indicator) {
                const newCollapsedState = !isCurrentlyCollapsed;
                indicator.style.transform = newCollapsedState ? 'rotate(-90deg)' : 'rotate(0deg)';
                indicator.textContent = newCollapsedState ? '▶' : '▼';
            }
        }

        /**
         * Toggle dashboard minimize state with enhanced animations (Task 4.3)
         */
        toggleDashboardMinimize(dashboard) {
            const content = dashboard.querySelector('.dashboard-content');
            const footer = dashboard.querySelector('.dashboard-footer');
            const minimizeBtn = dashboard.querySelector('#dashboard-minimize');
            const header = dashboard.querySelector('.dashboard-header');

            const isMinimized = content.style.display === 'none';

            if (isMinimized) {
                // Expand with animation
                this.expandDashboard(dashboard, content, footer, minimizeBtn, header);
            } else {
                // Minimize with animation
                this.minimizeDashboard(dashboard, content, footer, minimizeBtn, header);
            }
        }

        /**
         * Expand dashboard with smooth animation (Task 4.3)
         */
        expandDashboard(dashboard, content, footer, minimizeBtn, header) {
            // Update button first
            minimizeBtn.textContent = '−';
            minimizeBtn.title = 'Minimize dashboard';

            // Show content with fade-in effect
            content.style.display = 'block';
            footer.style.display = 'block';
            content.style.opacity = '0';
            footer.style.opacity = '0';

            // Animate expansion
            dashboard.style.transition = 'all 0.3s ease';
            dashboard.style.height = 'auto';

            // Fade in content
            setTimeout(() => {
                content.style.transition = 'opacity 0.2s ease';
                footer.style.transition = 'opacity 0.2s ease';
                content.style.opacity = '1';
                footer.style.opacity = '1';
            }, 100);

            // Update header subtitle
            const subtitle = header.querySelector('div:last-child');
            if (subtitle) {
                subtitle.textContent = this.getDashboardSubtitle();
            }
        }

        /**
         * Minimize dashboard with smooth animation (Task 4.3)
         */
        minimizeDashboard(dashboard, content, footer, minimizeBtn, header) {
            // Fade out content first
            content.style.transition = 'opacity 0.2s ease';
            footer.style.transition = 'opacity 0.2s ease';
            content.style.opacity = '0';
            footer.style.opacity = '0';

            setTimeout(() => {
                content.style.display = 'none';
                footer.style.display = 'none';

                // Update button
                minimizeBtn.textContent = '+';
                minimizeBtn.title = 'Expand dashboard';

                // Animate minimize
                dashboard.style.transition = 'all 0.3s ease';
                dashboard.style.height = 'auto';

                // Update header subtitle to show summary
                const subtitle = header.querySelector('div:last-child');
                if (subtitle) {
                    subtitle.textContent = this.getMinimizedSummary();
                }
            }, 200);
        }

        /**
         * Get dashboard subtitle for expanded state (Task 4.3)
         */
        getDashboardSubtitle() {
            // This would be populated with actual concern data
            return 'All systems good'; // Placeholder
        }

        /**
         * Get summary text for minimized state (Task 4.3)
         */
        getMinimizedSummary() {
            // This would show a brief summary of concerns
            return 'Click to expand dashboard'; // Placeholder
        }

        /**
         * Add smooth animation classes and transitions (Task 4.3)
         */
        addDashboardAnimations(dashboard) {
            // Add CSS transitions for smooth interactions
            dashboard.style.transition = 'all 0.3s ease';

            // Add hover effects for interactive elements
            const style = document.createElement('style');
            style.textContent = `
                #schoology-parent-dashboard .concern-item:hover {
                    transform: translateX(2px);
                    transition: transform 0.2s ease;
                }
                
                #schoology-parent-dashboard .section-header:hover {
                    background-color: rgba(0,0,0,0.02);
                    transition: background-color 0.2s ease;
                }
                
                #schoology-parent-dashboard button:hover {
                    transform: scale(1.05);
                    transition: transform 0.2s ease;
                }
            `;
            document.head.appendChild(style);
        }

        /**
         * Position the dashboard on the page to avoid conflicts
         */
        positionDashboard(dashboard) {
            // Simple, reliable positioning - just use a fixed right offset
            let rightOffset = 20;

            // Check if there are any existing Schoology elements that might conflict
            const existingPanels = document.querySelectorAll('[class*="panel"], [class*="sidebar"], [id*="sidebar"]');

            // Only adjust if we find panels that are actually in the way
            existingPanels.forEach(panel => {
                const rect = panel.getBoundingClientRect();
                // If panel is on the right side and would overlap with our dashboard
                if (rect.right > window.innerWidth - 420 && rect.right < window.innerWidth - 20) {
                    rightOffset = Math.max(rightOffset, 40); // Just move it a bit more to the left
                }
            });

            // Ensure we don't go off-screen
            rightOffset = Math.min(rightOffset, window.innerWidth - 400);

            console.log('Setting dashboard right offset to:', rightOffset + 'px');
            dashboard.style.right = rightOffset + 'px';
        }

        /**
         * Analyze upcoming assignments for priority and workload (Task 3.4)
         * @param {Array} assignments - Array of assignment objects
         * @param {Array} grades - Array of grade objects
         * @returns {Object} Upcoming assignment analysis with priorities and workload
         */
        analyzeUpcomingAssignments(assignments, grades) {
            console.log('Analyzing upcoming assignments...');

            const analysis = {
                totalUpcoming: 0,
                upcomingAssignments: [],
                majorAssignments: [],
                workloadByWeek: {},
                priorityAssignments: [],
                subjectWorkload: {},
                hasHighWorkload: false,
                nextWeekWorkload: 0,
                urgentAssignments: []
            };

            const now = new Date();
            const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            const upcomingWindow = this.configManager.getUpcomingDaysWindow();
            const upcomingDeadline = new Date(now.getTime() + upcomingWindow * 24 * 60 * 60 * 1000);

            // Analyze each assignment
            assignments.forEach(assignment => {
                if (assignment.dueDate) {
                    const dueDate = new Date(assignment.dueDate);

                    // Only analyze future assignments within the configured window
                    if (dueDate > now && dueDate <= upcomingDeadline) {
                        const assignmentAnalysis = this.analyzeIndividualAssignment(assignment, grades, now);

                        analysis.upcomingAssignments.push(assignmentAnalysis);
                        analysis.totalUpcoming++;

                        // Track by subject
                        if (!analysis.subjectWorkload[assignment.subject]) {
                            analysis.subjectWorkload[assignment.subject] = 0;
                        }
                        analysis.subjectWorkload[assignment.subject]++;

                        // Track by week
                        const weekKey = this.getWeekKey(dueDate);
                        if (!analysis.workloadByWeek[weekKey]) {
                            analysis.workloadByWeek[weekKey] = [];
                        }
                        analysis.workloadByWeek[weekKey].push(assignmentAnalysis);

                        // Count next week workload
                        if (dueDate <= nextWeek) {
                            analysis.nextWeekWorkload++;
                        }

                        // Identify major assignments
                        if (assignmentAnalysis.isMajor) {
                            analysis.majorAssignments.push(assignmentAnalysis);
                        }

                        // Identify priority assignments
                        if (assignmentAnalysis.priority === 'high' || assignmentAnalysis.priority === 'urgent') {
                            analysis.priorityAssignments.push(assignmentAnalysis);
                        }

                        // Identify urgent assignments (due within 2 days)
                        if (assignmentAnalysis.daysUntilDue <= 2) {
                            analysis.urgentAssignments.push(assignmentAnalysis);
                        }
                    }
                }
            });

            // Determine if there's high workload
            analysis.hasHighWorkload = analysis.nextWeekWorkload >= 5 ||
                analysis.majorAssignments.length >= 3 ||
                analysis.urgentAssignments.length >= 2;

            // Sort assignments by priority and due date
            analysis.upcomingAssignments.sort((a, b) => {
                const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
                const aPriority = priorityOrder[a.priority] || 1;
                const bPriority = priorityOrder[b.priority] || 1;

                if (aPriority !== bPriority) {
                    return bPriority - aPriority; // Higher priority first
                }
                return a.daysUntilDue - b.daysUntilDue; // Earlier due date first
            });

            console.log('Upcoming assignment analysis complete:', {
                total: analysis.totalUpcoming,
                nextWeek: analysis.nextWeekWorkload,
                major: analysis.majorAssignments.length,
                urgent: analysis.urgentAssignments.length,
                highWorkload: analysis.hasHighWorkload
            });

            return analysis;
        }

        /**
         * Analyze individual assignment for priority and characteristics (Task 3.4)
         */
        analyzeIndividualAssignment(assignment, grades, now) {
            const dueDate = new Date(assignment.dueDate);
            const daysUntilDue = Math.ceil((dueDate - now) / (24 * 60 * 60 * 1000));

            // Determine if it's a major assignment
            const isMajor = this.isMajorAssignment(assignment);

            // Calculate priority based on multiple factors
            const priority = this.calculateAssignmentPriority(assignment, daysUntilDue, isMajor);

            // Check if student has been struggling in this subject
            const subjectPerformance = this.getSubjectPerformance(assignment.subject, grades);

            return {
                name: assignment.name,
                subject: assignment.subject,
                dueDate: assignment.dueDate,
                daysUntilDue: daysUntilDue,
                isMajor: isMajor,
                priority: priority,
                subjectPerformance: subjectPerformance,
                estimatedWorkload: this.estimateWorkload(assignment),
                status: assignment.status || 'pending',
                category: assignment.category || 'assignment',
                maxPoints: assignment.maxPoints || null,
                description: assignment.description || null
            };
        }

        /**
         * Determine if an assignment is major based on keywords and point value (Task 3.4)
         */
        isMajorAssignment(assignment) {
            const majorKeywords = [
                'test', 'exam', 'quiz', 'project', 'essay', 'paper', 'presentation',
                'midterm', 'final', 'report', 'research', 'portfolio', 'assessment'
            ];

            const name = (assignment.name || '').toLowerCase();
            const category = (assignment.category || '').toLowerCase();
            const description = (assignment.description || '').toLowerCase();

            // Check for major keywords
            const hasKeyword = majorKeywords.some(keyword =>
                name.includes(keyword) || category.includes(keyword) || description.includes(keyword)
            );

            // Check for high point value (if available)
            const hasHighPoints = assignment.maxPoints && assignment.maxPoints >= 50;

            return hasKeyword || hasHighPoints;
        }

        /**
         * Calculate assignment priority based on multiple factors (Task 3.4)
         */
        calculateAssignmentPriority(assignment, daysUntilDue, isMajor) {
            let priorityScore = 0;

            // Days until due (more urgent = higher score)
            if (daysUntilDue <= 1) priorityScore += 4;
            else if (daysUntilDue <= 2) priorityScore += 3;
            else if (daysUntilDue <= 3) priorityScore += 2;
            else if (daysUntilDue <= 7) priorityScore += 1;

            // Major assignment bonus
            if (isMajor) priorityScore += 2;

            // High point value bonus
            if (assignment.maxPoints && assignment.maxPoints >= 100) priorityScore += 1;

            // Status considerations
            if (assignment.status && assignment.status.toLowerCase().includes('late')) {
                priorityScore += 3;
            }

            // Convert score to priority level
            if (priorityScore >= 6) return 'urgent';
            if (priorityScore >= 4) return 'high';
            if (priorityScore >= 2) return 'medium';
            return 'low';
        }

        /**
         * Get subject performance based on existing grades (Task 3.4)
         */
        getSubjectPerformance(subject, grades) {
            const subjectGrades = grades.filter(grade =>
                grade.subject && grade.subject.includes(subject)
            );

            if (subjectGrades.length === 0) {
                return { level: 'unknown', average: null, gradeCount: 0 };
            }

            let totalPercentage = 0;
            let validGrades = 0;

            subjectGrades.forEach(grade => {
                if (grade.grade && typeof grade.grade === 'object' && grade.grade.percentage) {
                    totalPercentage += grade.grade.percentage;
                    validGrades++;
                } else if (typeof grade.grade === 'number') {
                    totalPercentage += grade.grade;
                    validGrades++;
                }
            });

            if (validGrades === 0) {
                return { level: 'unknown', average: null, gradeCount: subjectGrades.length };
            }

            const average = totalPercentage / validGrades;
            let level = 'good';

            if (average < 60) level = 'struggling';
            else if (average < 70) level = 'needs_attention';
            else if (average < 80) level = 'fair';
            else if (average >= 90) level = 'excellent';

            return { level, average: Math.round(average), gradeCount: subjectGrades.length };
        }

        /**
         * Estimate workload for an assignment (Task 3.4)
         */
        estimateWorkload(assignment) {
            let workload = 'medium'; // default

            // Base on assignment type and point value
            if (assignment.maxPoints) {
                if (assignment.maxPoints >= 100) workload = 'high';
                else if (assignment.maxPoints <= 10) workload = 'low';
            }

            // Adjust based on keywords
            const name = (assignment.name || '').toLowerCase();
            const highWorkloadKeywords = ['project', 'essay', 'paper', 'research', 'presentation', 'portfolio'];
            const lowWorkloadKeywords = ['quiz', 'worksheet', 'discussion', 'participation'];

            if (highWorkloadKeywords.some(keyword => name.includes(keyword))) {
                workload = 'high';
            } else if (lowWorkloadKeywords.some(keyword => name.includes(keyword))) {
                workload = 'low';
            }

            return workload;
        }

        /**
         * Get week key for grouping assignments (Task 3.4)
         */
        getWeekKey(date) {
            const startOfWeek = new Date(date);
            startOfWeek.setDate(date.getDate() - date.getDay()); // Start of week (Sunday)
            return startOfWeek.toISOString().split('T')[0]; // YYYY-MM-DD format
        }

        // ===== HELPER METHODS FOR INDIVIDUAL CONCERN RENDERING (Task 4.2) =====

        /**
         * Render section header with concern count indicator (Task 4.2)
         */
        renderSectionHeader(title, concernCount = 0) {
            return `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; cursor: pointer; user-select: none;" class="section-header">
                    <h3 style="margin: 0; font-size: 14px; font-weight: 600; color: #24292e; display: flex; align-items: center;">
                        <span class="collapse-indicator" style="margin-right: 8px; font-size: 12px; color: #6b7280; transition: transform 0.2s ease;">▼</span>
                        ${title}
                    </h3>
                    ${concernCount > 0 ? `
                        <span style="
                            background: #dc2626; 
                            color: white; 
                            font-size: 10px; 
                            font-weight: 600; 
                            padding: 2px 6px; 
                            border-radius: 10px;
                            min-width: 16px;
                            text-align: center;
                        ">${concernCount}</span>
                    ` : ''}
                </div>
            `;
        }

        /**
         * Render empty section template (Task 4.2)
         */
        renderEmptySection(title, message) {
            return `
                <div style="padding: 16px 20px; border-bottom: 1px solid #e1e4e8;">
                    <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #24292e;">
                        ${title}
                    </h3>
                    <div style="color: #586069; font-size: 13px;">${message}</div>
                </div>
            `;
        }

        /**
         * Render success message template (Task 4.2)
         */
        renderSuccessMessage(message, color = '#059669') {
            return `
                <div style="font-size: 12px; color: ${color}; margin-top: 8px;">
                    ✅ ${message}
                </div>
            `;
        }

        /**
         * Render grade breakdown display (Task 4.2)
         */
        renderGradeBreakdown(gradeBreakdown) {
            return `
                <div style="font-size: 12px; color: #374151; margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span>Grade Distribution:</span>
                        <span style="font-family: monospace;">A:${gradeBreakdown.A} B:${gradeBreakdown.B} C:${gradeBreakdown.C} D:${gradeBreakdown.D} F:${gradeBreakdown.F}</span>
                    </div>
                </div>
            `;
        }

        // ===== MAIN APPLICATION CONTROLLER METHODS (Task 6.1) =====

        /**
         * Scan page content and extract all data
         * Coordinates data extraction from all sources
         * @returns {Promise<Object>} Object containing all extracted data
         */
        async scanPageContent() {
            console.log('SchoolgyParentDashboard: Scanning page content...');

            const extractedData = {
                grades: [],
                assignments: [],
                comments: [],
                analysis: {},
                warnings: [],
                timestamp: new Date()
            };

            try {
                // Extract data using the data extractor with individual error handling
                let grades = [];
                try {
                    grades = await this.dataExtractor.extractGrades();
                    console.log(`✓ Successfully extracted ${grades.length} grades`);
                } catch (gradeError) {
                    console.warn('Grade extraction failed:', gradeError);
                    const partialResult = this.handlePartialExtractionFailure('grades', gradeError, { grades: [] });
                    extractedData.warnings.push(...partialResult.warnings);
                }

                let assignments = [];
                try {
                    assignments = this.dataExtractor.extractAssignments();
                    console.log(`✓ Successfully extracted ${assignments.length} assignments`);
                } catch (assignmentError) {
                    console.warn('Assignment extraction failed:', assignmentError);
                    const partialResult = this.handlePartialExtractionFailure('assignments', assignmentError, { assignments: [] });
                    extractedData.warnings.push(...partialResult.warnings);
                }

                let comments = [];
                try {
                    comments = this.dataExtractor.extractComments();
                    console.log(`✓ Successfully extracted ${comments.length} comments`);
                } catch (commentError) {
                    console.warn('Comment extraction failed:', commentError);
                    const partialResult = this.handlePartialExtractionFailure('comments', commentError, { comments: [] });
                    extractedData.warnings.push(...partialResult.warnings);
                }

                // Update extracted data
                extractedData.grades = grades;
                extractedData.assignments = assignments;
                extractedData.comments = comments;

                // Analyze the extracted data with error handling
                let gradeAnalysis = {};
                try {
                    gradeAnalysis = this.analyzeGrades(grades);
                    console.log('✓ Grade analysis completed');
                } catch (analysisError) {
                    console.warn('Grade analysis failed:', analysisError);
                    this.handleError(analysisError, 'gradeAnalysis');
                    gradeAnalysis = { hasLowGrades: false, lowGrades: [], totalGrades: 0 };
                }

                let commentAnalysis = {};
                try {
                    commentAnalysis = this.analyzeCommentSentiment(comments);
                    console.log('✓ Comment analysis completed');
                } catch (analysisError) {
                    console.warn('Comment analysis failed:', analysisError);
                    this.handleError(analysisError, 'commentAnalysis');
                    commentAnalysis = { hasNegativeComments: false, negativeComments: [], totalComments: 0 };
                }

                let missingAssignments = {};
                try {
                    missingAssignments = this.detectMissingAssignments(assignments, grades);
                    console.log('✓ Missing assignment detection completed');
                } catch (missingError) {
                    console.warn('Missing assignment detection failed:', missingError);
                    this.handleError(missingError, 'missingAssignments');
                    missingAssignments = {
                        totalAssignments: assignments.filter(a => a.name && a.name.trim() !== '' && !a.name.toLowerCase().includes('exempt') && a.status !== 'exempt' && a.status !== 'excused').length,
                        totalGrades: grades.length,
                        missingSubmissions: [],
                        lateSubmissions: [],
                        waitingForGrading: [],
                        upcomingDueDates: [],
                        hasMissingWork: false,
                        totalMissing: 0,
                        totalLate: 0,
                        totalWaiting: 0,
                        totalUpcoming: 0
                    };
                }

                let upcomingAnalysis = {};
                try {
                    upcomingAnalysis = this.analyzeUpcomingAssignments(assignments, grades);
                    console.log('✓ Upcoming assignment analysis completed');
                } catch (analysisError) {
                    console.warn('Upcoming assignment analysis failed:', analysisError);
                    this.handleError(analysisError, 'upcomingAssignments');
                    upcomingAnalysis = { hasUpcomingAssignments: false, upcomingAssignments: [], totalUpcoming: 0 };
                }

                extractedData.analysis = {
                    grades: gradeAnalysis,
                    comments: commentAnalysis,
                    missing: missingAssignments,
                    upcoming: upcomingAnalysis
                };

                console.log('SchoolgyParentDashboard: Page content scan complete', {
                    gradesFound: grades.length,
                    assignmentsFound: assignments.length,
                    commentsFound: comments.length,
                    warningsCount: extractedData.warnings.length
                });

                // Show any extraction warnings to the user
                if (extractedData.warnings.length > 0) {
                    setTimeout(() => this.showExtractionWarnings(extractedData.warnings), 1000);
                }

                return extractedData;

            } catch (error) {
                console.error('SchoolgyParentDashboard: Error scanning page content:', error);
                return {
                    grades: [],
                    assignments: [],
                    comments: [],
                    analysis: {
                        grades: { hasGrades: false, message: 'Error extracting grades' },
                        comments: { hasNegativeComments: false, totalComments: 0 },
                        missing: { hasMissingAssignments: false, assignments: [] },
                        upcoming: { hasUpcomingAssignments: false, assignments: [] }
                    },
                    error: error.message,
                    timestamp: new Date()
                };
            }
        }

        /**
         * Update the parent concerns panel with new data
         * Refreshes the UI with current page content
         * @param {Object} data - Optional data to use, if not provided will scan page
         * @returns {Promise<boolean>} Success status
         */
        async updatePanel(data = null) {
            console.log('SchoolgyParentDashboard: Updating panel...');

            try {
                // Get data either from parameter or by scanning page
                const panelData = data || await this.scanPageContent();

                // Find existing panel or create new one
                let existingPanel = document.getElementById('schoology-parent-dashboard');

                if (existingPanel) {
                    console.log('SchoolgyParentDashboard: Updating existing panel');
                    // Update existing panel content
                    this.updateExistingPanel(existingPanel, panelData);
                } else {
                    console.log('SchoolgyParentDashboard: Creating new panel');
                    // Create new panel
                    this.createParentDashboard(
                        panelData.grades,
                        panelData.assignments,
                        panelData.comments,
                        panelData.analysis.comments,
                        panelData.analysis.grades,
                        panelData.analysis.missing,
                        panelData.analysis.upcoming
                    );
                }

                console.log('SchoolgyParentDashboard: Panel update complete');
                return true;

            } catch (error) {
                console.error('SchoolgyParentDashboard: Error updating panel:', error);
                return false;
            }
        }

        /**
         * Update existing panel content without recreating the entire panel
         * @param {Element} panel - The existing panel element
         * @param {Object} data - New data to display
         */
        updateExistingPanel(panel, data) {
            console.log('SchoolgyParentDashboard: Refreshing panel content...');

            try {
                // Find the content container within the panel
                const contentContainer = panel.querySelector('.dashboard-content');
                if (!contentContainer) {
                    console.warn('SchoolgyParentDashboard: Content container not found, recreating panel');
                    panel.remove();
                    this.updatePanel(data);
                    return;
                }

                // Preserve panel state (collapsed/expanded)
                const isCollapsed = panel.classList.contains('collapsed');

                // Regenerate content using existing methods
                const renderer = new PanelRenderer();
                const newContent = renderer.renderConcernSections(
                    data.analysis.grades,
                    data.analysis.missing,
                    data.analysis.comments,
                    data.analysis.upcoming
                );

                // Update the content
                contentContainer.innerHTML = newContent;

                // Restore panel state
                if (isCollapsed) {
                    panel.classList.add('collapsed');
                }

                // Update timestamp
                const timestampElement = panel.querySelector('.last-updated');
                if (timestampElement) {
                    timestampElement.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
                }

                console.log('SchoolgyParentDashboard: Panel content refreshed successfully');

            } catch (error) {
                console.error('SchoolgyParentDashboard: Error refreshing panel content:', error);
                // Fallback: recreate the entire panel
                panel.remove();
                this.updatePanel(data);
            }
        }

        /**
         * Handle dynamic page changes and content updates
         * Sets up monitoring for Schoology's AJAX content loading
         * @param {boolean} enable - Whether to enable or disable monitoring
         */
        handlePageChanges(enable = true) {
            console.log(`SchoolgyParentDashboard: ${enable ? 'Enabling' : 'Disabling'} page change monitoring`);

            // Content observer removed - no longer needed

            // Clear any existing debounce timers
            if (this.updateTimeout) {
                clearTimeout(this.updateTimeout);
                this.updateTimeout = null;
            }

            if (!enable) {
                return;
            }

            // Initialize debounce configuration
            this.debounceConfig = {
                normalDelay: 1000,      // Normal updates wait 1 second
                significantDelay: 500,  // Significant changes wait 0.5 seconds
                maxWaitTime: 5000,      // Maximum time to wait before forcing update
                lastUpdateTime: 0       // Track last update time
            };

            // Enhanced mutation observer removed - not needed for static pages

            // Dynamic updates disabled - grade pages are static after initial load
            // if (changeInfo.shouldUpdate) {
            //     console.log('SchoolgyParentDashboard: Page content changed:', changeInfo);
            //     this.debouncedUpdate(changeInfo);
            // }

            // All monitoring removed - grade pages are static after initial load

            console.log('SchoolgyParentDashboard: Enhanced page change monitoring enabled');
        }

        // Dynamic monitoring methods removed - not needed for static grade pages
        analyzeMutations(mutations) {
            return { shouldUpdate: false };
        }

        analyzeChildListChanges(mutation, analysis) {
            return;
        }

        analyzeAttributeChanges(mutation, analysis) {
            return;
        }

        isGradeRelatedElement(element) {
            return false;
        }

        isAssignmentRelatedElement(element) {
            return false;
        }

        isCommentRelatedElement(element) {
            return false;
        }

        isMajorContentContainer(element) {
            return false;
        }

        debouncedUpdate(changeInfo) {
            return;
        }

        handleUrlChange(oldUrl, newUrl) {
            return;
        }






        /**
         * Hide visual course links in the Schoology interface based on configuration
         */
        hideVisualCourseLinks() {
            console.log('Schoology Parent Dashboard: *** ENTERING hideVisualCourseLinks method ***');
            console.log('Schoology Parent Dashboard: Updating visual course visibility...');

            // First, show all previously hidden courses to reset the state
            console.log('Schoology Parent Dashboard: Restoring all previously hidden courses...');
            this.showAllHiddenCourses();

            // Common selectors for course links in Schoology
            const courseLinkSelectors = [
                'a[href*="/course/"]',  // Course links
                '.course-title',        // Course title elements
                '.gradebook-course-title', // Gradebook course titles
                'tr[data-id]',         // Course rows with data-id
                '.course-item',        // Course items
                '.course-row'          // Course rows
            ];

            let hiddenCount = 0;

            courseLinkSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);

                elements.forEach(element => {
                    // Get the course name from the element
                    let courseName = '';

                    // Try different ways to extract course name
                    if (element.textContent) {
                        courseName = element.textContent.trim();
                    } else if (element.title) {
                        courseName = element.title.trim();
                    } else if (element.getAttribute('aria-label')) {
                        courseName = element.getAttribute('aria-label').trim();
                    }

                    // Debug: Log all course names found
                    if (courseName) {
                        console.log(`Found course: "${courseName}"`);
                    }

                    // Check if this course should be hidden
                    if (courseName && this.configManager.isCourseHidden(courseName)) {
                        console.log(`✓ Hiding course link: ${courseName}`);

                        // Find the most specific container for this course only
                        // Be more careful to avoid hiding containers with multiple courses
                        let targetElement = element;
                        console.log(`  - Starting with element: ${element.tagName} with classes: ${element.className}`);

                        // Look for a course-specific container, but be selective
                        const courseContainer = element.closest('tr[data-id]') || // Specific course row
                            element.closest('li') ||           // List item
                            element.closest('.course-item');   // Course item

                        console.log(`  - Found container: ${courseContainer ? courseContainer.tagName : 'none'}`);

                        if (courseContainer) {
                            // Double-check this container only contains the hidden course
                            const containerText = courseContainer.textContent || '';
                            console.log(`  - Container text preview: "${containerText.substring(0, 100)}..."`);

                            const otherCourseNames = [
                                'Ag Sci', 'Algebra', 'Anatomy', 'English', 'Homeroom',
                                'NGSS', 'Per Fin', 'Theatre', 'US History'
                            ];

                            const hasOtherCourses = otherCourseNames.some(name =>
                                containerText.includes(name) && !containerText.includes('Hereford')
                            );

                            console.log(`  - Container has other courses: ${hasOtherCourses}`);

                            if (!hasOtherCourses) {
                                targetElement = courseContainer;
                                console.log(`  - Using container: ${targetElement.tagName} with classes: ${targetElement.className}`);
                            } else {
                                console.log(`  - Container has other courses, hiding only the link element`);
                            }
                        } else {
                            console.log(`  - No suitable container found, using original element`);
                        }

                        // Add a class for identification
                        targetElement.classList.add('schoology-dashboard-hidden-course');

                        // Use CSS to completely collapse the element
                        console.log(`  - Collapsing element: ${targetElement.tagName} with classes: ${targetElement.className}`);

                        // Apply aggressive collapsing styles
                        targetElement.style.cssText = `
                            display: none !important;
                            visibility: hidden !important;
                            height: 0 !important;
                            min-height: 0 !important;
                            max-height: 0 !important;
                            margin: 0 !important;
                            padding: 0 !important;
                            border: none !important;
                            overflow: hidden !important;
                            line-height: 0 !important;
                            font-size: 0 !important;
                            opacity: 0 !important;
                            position: absolute !important;
                            left: -9999px !important;
                            width: 0 !important;
                        `;

                        // Verify the styles were applied
                        console.log(`  - Applied styles. Display is now: ${window.getComputedStyle(targetElement).display}`);
                        console.log(`  - Element visibility: ${window.getComputedStyle(targetElement).visibility}`);
                        console.log(`  - Element height: ${window.getComputedStyle(targetElement).height}`);

                        hiddenCount++;
                    }
                });
            });

            // Add CSS to ensure hidden courses stay completely hidden
            const style = document.createElement('style');
            style.id = 'schoology-dashboard-hidden-courses-style';
            style.textContent = `
                .schoology-dashboard-hidden-course,
                .schoology-dashboard-hidden-course * {
                    display: none !important;
                    visibility: hidden !important;
                    height: 0 !important;
                    min-height: 0 !important;
                    max-height: 0 !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    border: none !important;
                    overflow: hidden !important;
                    line-height: 0 !important;
                    font-size: 0 !important;
                    opacity: 0 !important;
                    position: absolute !important;
                    left: -9999px !important;
                    width: 0 !important;
                    z-index: -1 !important;
                }
            `;

            // Remove existing style if present
            const existingStyle = document.getElementById('schoology-dashboard-hidden-courses-style');
            if (existingStyle) {
                existingStyle.remove();
            }

            document.head.appendChild(style);

            if (hiddenCount > 0) {
                console.log(`Schoology Parent Dashboard: Completely hidden ${hiddenCount} course links`);
            } else {
                console.log('Schoology Parent Dashboard: No course links to hide');
            }
        }

        /**
         * Show all previously hidden courses (used when refreshing visibility)
         */
        showAllHiddenCourses() {
            const hiddenElements = document.querySelectorAll('.schoology-dashboard-hidden-course');
            hiddenElements.forEach(element => {
                // Restore original display value
                const originalDisplay = element.getAttribute('data-original-display');
                if (originalDisplay) {
                    element.style.display = originalDisplay;
                    element.removeAttribute('data-original-display');
                } else {
                    element.style.display = '';
                }

                // Clear all hiding styles
                element.style.visibility = '';
                element.style.height = '';
                element.style.margin = '';
                element.style.padding = '';
                element.style.border = '';

                // Remove the hiding class
                element.classList.remove('schoology-dashboard-hidden-course');
            });

            // Remove the hiding CSS
            const existingStyle = document.getElementById('schoology-dashboard-hidden-courses-style');
            if (existingStyle) {
                existingStyle.remove();
            }
        }

        /**
         * Graceful error handling and recovery
         * @param {Error} error - The error that occurred
         * @param {string} context - Context where the error occurred
         */
        /**
         * Handle partial extraction failures gracefully
         * @param {string} extractionType - Type of extraction that failed
         * @param {Error} error - The error that occurred
         * @param {Object} partialData - Any data that was successfully extracted
         * @returns {Object} Processed data with error information
         */
        handlePartialExtractionFailure(extractionType, error, partialData = {}) {
            console.warn(`SchoolgyParentDashboard: Partial ${extractionType} extraction failure:`, error);

            // Add warning to the data
            const warningMessage = {
                type: 'extraction_warning',
                extractionType,
                message: `Some ${extractionType} data could not be loaded`,
                timestamp: new Date().toISOString()
            };

            // Return partial data with warning
            return {
                ...partialData,
                warnings: [...(partialData.warnings || []), warningMessage],
                isPartial: true
            };
        }

        /**
         * Show extraction warnings to the user in a non-intrusive way
         * @param {Array} warnings - Array of warning objects
         */
        showExtractionWarnings(warnings) {
            if (!warnings || warnings.length === 0) return;

            const panel = document.getElementById('schoology-parent-dashboard');
            if (!panel) return;

            const warningContainer = panel.querySelector('.extraction-warnings') ||
                this.createWarningContainer(panel);

            const warningMessages = warnings.map(warning => {
                const friendlyMessages = {
                    'grades': 'Some grades may not be displayed',
                    'assignments': 'Some assignments may be missing',
                    'comments': 'Some teacher comments may not be shown',
                    'dates': 'Some due dates may be incorrect'
                };

                return friendlyMessages[warning.extractionType] || warning.message;
            });

            warningContainer.innerHTML = `
                <div style="
                    background: #fef3c7; 
                    border: 1px solid #f59e0b; 
                    border-radius: 4px; 
                    padding: 8px 12px; 
                    margin: 8px 0; 
                    font-size: 12px;
                    color: #92400e;
                ">
                    <div style="font-weight: 600; margin-bottom: 4px;">
                        ⚠️ Data Loading Issues
                    </div>
                    <ul style="margin: 0; padding-left: 16px;">
                        ${warningMessages.map(msg => `<li>${msg}</li>`).join('')}
                    </ul>
                    <div style="margin-top: 4px; font-size: 11px;">
                        Try refreshing the page if data appears incomplete.
                    </div>
                </div>
            `;
        }

        /**
         * Create warning container for extraction warnings
         * @param {Element} panel - The dashboard panel element
         * @returns {Element} Warning container element
         */
        createWarningContainer(panel) {
            const container = document.createElement('div');
            container.className = 'extraction-warnings';

            const contentArea = panel.querySelector('.dashboard-content');
            if (contentArea) {
                contentArea.insertBefore(container, contentArea.firstChild);
            }

            return container;
        }

        /**
         * Provide diagnostic information for troubleshooting extraction issues
         * @returns {Object} Diagnostic information about the current page
         */
        getDiagnosticInfo() {
            const diagnostics = {
                pageInfo: {
                    url: window.location.href,
                    title: document.title,
                    domain: window.location.hostname,
                    timestamp: new Date().toISOString()
                },
                domInfo: {
                    totalElements: document.querySelectorAll('*').length,
                    gradeElements: document.querySelectorAll('tr[class*="grade"]').length,
                    courseElements: document.querySelectorAll('.gradebook-course-title').length,
                    tableElements: document.querySelectorAll('table').length,
                    hasGradebook: !!document.querySelector('.gradebook-table, [class*="gradebook"]'),
                    hasReportRows: document.querySelectorAll('tr.report-row').length
                },
                schoologyInfo: {
                    isSchoolgyDomain: window.location.hostname.includes('schoology.com'),
                    hasSchoolgyElements: !!document.querySelector('[class*="schoology"], [id*="schoology"]'),
                    pageType: this.detectPageType(),
                    markingPeriod: this.dataExtractor.detectCurrentMarkingPeriod()
                },
                browserInfo: {
                    userAgent: navigator.userAgent,
                    cookiesEnabled: navigator.cookieEnabled,
                    localStorageAvailable: this.storageManager.isLocalStorageAvailable(),
                    viewportSize: `${window.innerWidth}x${window.innerHeight}`
                }
            };

            return diagnostics;
        }

        /**
         * Detect the type of Schoology page we're on
         * @returns {string} Page type identifier
         */
        detectPageType() {
            const url = window.location.href;
            const title = document.title.toLowerCase();

            if (url.includes('/grades') || title.includes('grade')) {
                if (url.includes('/parent/')) return 'parent-grades';
                if (url.includes('/course/')) return 'course-grades';
                return 'grades-general';
            }

            if (url.includes('/course/')) return 'course-page';
            if (url.includes('/parent/')) return 'parent-portal';

            return 'unknown';
        }

        /**
         * Generate a comprehensive error report for support
         * @param {Error} error - The error that occurred
         * @param {string} context - Context where the error occurred
         * @returns {string} Formatted error report
         */
        generateErrorReport(error, context) {
            const diagnostics = this.getDiagnosticInfo();

            const report = `
SCHOOLOGY PARENT DASHBOARD ERROR REPORT
=====================================

Error Context: ${context}
Timestamp: ${new Date().toISOString()}

ERROR DETAILS:
${error.message}
${error.stack || 'No stack trace available'}

PAGE INFORMATION:
- URL: ${diagnostics.pageInfo.url}
- Title: ${diagnostics.pageInfo.title}
- Page Type: ${diagnostics.schoologyInfo.pageType}
- Marking Period: ${diagnostics.schoologyInfo.markingPeriod}

DOM ANALYSIS:
- Total Elements: ${diagnostics.domInfo.totalElements}
- Grade Elements Found: ${diagnostics.domInfo.gradeElements}
- Course Elements Found: ${diagnostics.domInfo.courseElements}
- Has Gradebook: ${diagnostics.domInfo.hasGradebook}
- Report Rows: ${diagnostics.domInfo.hasReportRows}

BROWSER ENVIRONMENT:
- User Agent: ${diagnostics.browserInfo.userAgent}
- Cookies Enabled: ${diagnostics.browserInfo.cookiesEnabled}
- Local Storage: ${diagnostics.browserInfo.localStorageAvailable}
- Viewport: ${diagnostics.browserInfo.viewportSize}

SCHOOLOGY DETECTION:
- Is Schoology Domain: ${diagnostics.schoologyInfo.isSchoolgyDomain}
- Has Schoology Elements: ${diagnostics.schoologyInfo.hasSchoolgyElements}

This report can help diagnose issues with the Parent Dashboard.
            `.trim();

            return report;
        }

        /**
         * Get user-friendly error message based on context and error type
         * @param {Error} error - The error that occurred
         * @param {string} context - Context where the error occurred
         * @returns {Object} Error message object with title, message, and actions
         */
        getUserFriendlyErrorMessage(error, context) {
            const errorMessages = {
                'dataExtraction': {
                    title: '📊 Grade Data Issue',
                    message: 'Having trouble reading your grades from this page.',
                    actions: [
                        'Try refreshing the page',
                        'Make sure you\'re on a Schoology grades page',
                        'Check if all courses are fully loaded'
                    ],
                    technical: 'Grade extraction failed - DOM structure may have changed'
                },
                'gradeAnalysis': {
                    title: '🔍 Analysis Problem',
                    message: 'Could not analyze your grade data properly.',
                    actions: [
                        'Refresh the page to retry',
                        'Some grades may not be displayed correctly',
                        'Try switching between marking periods'
                    ],
                    technical: 'Grade analysis engine encountered an error'
                },
                'missingAssignments': {
                    title: '📋 Assignment Detection Issue',
                    message: 'Unable to detect missing assignments accurately.',
                    actions: [
                        'Check your assignments manually',
                        'Refresh the page to retry detection',
                        'Some missing assignments may not be shown'
                    ],
                    technical: 'Missing assignment detection failed'
                },
                'commentAnalysis': {
                    title: '💬 Comment Processing Error',
                    message: 'Could not read teacher comments properly.',
                    actions: [
                        'Check comments directly in Schoology',
                        'Refresh to retry comment analysis',
                        'Some comments may not appear in the dashboard'
                    ],
                    technical: 'Teacher comment extraction or analysis failed'
                },
                'upcomingAssignments': {
                    title: '📅 Upcoming Assignments Issue',
                    message: 'Having trouble finding upcoming assignments.',
                    actions: [
                        'Check your Schoology calendar directly',
                        'Refresh the page to retry',
                        'Verify assignment due dates manually'
                    ],
                    technical: 'Upcoming assignment detection failed'
                },
                'panelRendering': {
                    title: '🎨 Display Problem',
                    message: 'The dashboard panel could not be displayed properly.',
                    actions: [
                        'Refresh the page to reload the dashboard',
                        'Try disabling other browser extensions temporarily',
                        'Check if your browser supports this feature'
                    ],
                    technical: 'Panel rendering or DOM manipulation failed'
                },
                'configuration': {
                    title: '⚙️ Settings Issue',
                    message: 'Problem with dashboard settings or preferences.',
                    actions: [
                        'Settings have been reset to defaults',
                        'Try reconfiguring your preferences',
                        'Clear browser data if issues persist'
                    ],
                    technical: 'Configuration management error'
                },
                'storage': {
                    title: '💾 Storage Problem',
                    message: 'Cannot save or load your dashboard preferences.',
                    actions: [
                        'Check if your browser allows local storage',
                        'Try clearing browser data and refreshing',
                        'Settings may not persist between sessions'
                    ],
                    technical: 'Browser storage access failed'
                },
                'setupDashboard': {
                    title: '🚀 Startup Problem',
                    message: 'The dashboard failed to initialize properly.',
                    actions: [
                        'Refresh the page to retry setup',
                        'Make sure you\'re on a valid Schoology page',
                        'Try disabling other extensions temporarily'
                    ],
                    technical: 'Dashboard initialization failed'
                },
                'global': {
                    title: '⚠️ Unexpected Error',
                    message: 'Something unexpected happened with the dashboard.',
                    actions: [
                        'Refresh the page to restart the dashboard',
                        'Try logging out and back into Schoology',
                        'Contact support if the problem continues'
                    ],
                    technical: 'Unhandled global error occurred'
                }
            };

            // Get specific error message or fall back to generic
            const errorInfo = errorMessages[context] || errorMessages['global'];

            // Add specific error details if available
            if (error.message) {
                errorInfo.details = error.message;
            }

            return errorInfo;
        }

        handleError(error, context = 'unknown') {
            console.error(`SchoolgyParentDashboard: Error in ${context}:`, error);

            // Get user-friendly error message
            const errorInfo = this.getUserFriendlyErrorMessage(error, context);

            // Try to show user-friendly error message in panel
            try {
                const existingPanel = document.getElementById('schoology-parent-dashboard');
                if (existingPanel) {
                    const actionsList = errorInfo.actions.map(action =>
                        `<li style="margin: 2px 0;">${action}</li>`
                    ).join('');

                    const errorMessage = `
                        <div style="padding: 16px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; margin: 8px 0;">
                            <div style="color: #dc2626; font-weight: 600; margin-bottom: 8px;">
                                ${errorInfo.title}
                            </div>
                            <div style="color: #7f1d1d; font-size: 13px; margin-bottom: 8px;">
                                ${errorInfo.message}
                            </div>
                            <div style="color: #7f1d1d; font-size: 12px; margin-bottom: 8px;">
                                <strong>What you can try:</strong>
                                <ul style="margin: 4px 0 0 16px; padding: 0;">
                                    ${actionsList}
                                </ul>
                            </div>
                            ${errorInfo.details ? `
                                <details style="margin-top: 8px;">
                                    <summary style="color: #7f1d1d; font-size: 11px; cursor: pointer;">
                                        Technical Details
                                    </summary>
                                    <div style="color: #7f1d1d; font-size: 11px; margin-top: 4px; font-family: monospace; background: #f9f9f9; padding: 4px; border-radius: 3px;">
                                        ${errorInfo.technical}<br>
                                        Error: ${errorInfo.details}
                                    </div>
                                </details>
                            ` : ''}
                            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #fecaca;">
                                <button onclick="window.location.reload()" style="
                                    background: #dc2626; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 12px; 
                                    border-radius: 4px; 
                                    font-size: 12px; 
                                    cursor: pointer;
                                    margin-right: 8px;
                                ">
                                    🔄 Refresh Page
                                </button>
                                <button onclick="
                                    const report = window.schoolgyParentDashboard.generateErrorReport(new Error('${error.message?.replace(/'/g, "\\'")}'), '${context}');
                                    navigator.clipboard.writeText(report).then(() => {
                                        this.textContent = '✓ Copied!';
                                        setTimeout(() => this.textContent = '📋 Copy Report', 2000);
                                    }).catch(() => {
                                        const textarea = document.createElement('textarea');
                                        textarea.value = report;
                                        document.body.appendChild(textarea);
                                        textarea.select();
                                        document.execCommand('copy');
                                        document.body.removeChild(textarea);
                                        this.textContent = '✓ Copied!';
                                        setTimeout(() => this.textContent = '📋 Copy Report', 2000);
                                    });
                                " style="
                                    background: #059669; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 12px; 
                                    border-radius: 4px; 
                                    font-size: 12px; 
                                    cursor: pointer;
                                    margin-right: 8px;
                                ">
                                    📋 Copy Report
                                </button>
                                <button onclick="this.parentElement.parentElement.style.display='none'" style="
                                    background: #6b7280; 
                                    color: white; 
                                    border: none; 
                                    padding: 6px 12px; 
                                    border-radius: 4px; 
                                    font-size: 12px; 
                                    cursor: pointer;
                                ">
                                    ✕ Dismiss
                                </button>
                            </div>
                        </div>
                    `;

                    const contentContainer = existingPanel.querySelector('.dashboard-content');
                    if (contentContainer) {
                        contentContainer.innerHTML = errorMessage;
                    }
                }
            } catch (displayError) {
                console.error('SchoolgyParentDashboard: Failed to display error message:', displayError);
            }

            // Log error details for debugging
            console.error('SchoolgyParentDashboard: Error details:', {
                context,
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString(),
                url: window.location.href,
                userAgent: navigator.userAgent,
                errorInfo: errorInfo.technical
            });
        }

        /**
         * Clean up resources and event listeners
         * Called when the dashboard is being destroyed or page is unloading
         */
        cleanup() {
            console.log('SchoolgyParentDashboard: Cleaning up resources...');

            // Dynamic monitoring removed - no cleanup needed

            // Content observer cleanup removed - no longer needed

            // Clear any pending timeouts
            if (this.updateTimeout) {
                clearTimeout(this.updateTimeout);
                this.updateTimeout = null;
            }

            // Remove event listeners
            window.removeEventListener('beforeunload', this.cleanup.bind(this));

            console.log('SchoolgyParentDashboard: Cleanup complete');
        }
    }

    // Initialize the dashboard when script loads
    const dashboard = new SchoolgyParentDashboard();
    dashboard.init();

})();