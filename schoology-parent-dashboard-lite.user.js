// ==UserScript==
// @name         Schoology Parent Dashboard Lite
// @namespace    http://tampermonkey.net/
// @version      1.7.3
// @description  Lightweight dashboard showing missing assignments and current grades for the active marking period
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

    const VERSION = '1.7.3';

    class ParentDashboardLite {
        constructor() {
            this.currentMarkingPeriod = null;
            this.courses = [];
            this.mobile = this.isMobile();
            // Always start expanded — ignore any saved minimized state
            // (localStorage still saves the state for within-session minimize/expand)
            this.isMinimized = false;
            localStorage.setItem('pdl-minimized', 'false');
        }

        isMobile() {
            // Physical screen narrower than 600 CSS px, or a high-DPR device rendering a scaled-down desktop page
            return window.screen.width < 600 || 
                   (window.devicePixelRatio >= 2 && window.screen.width < 900);
        }

        getMobileTopOffset() {
            // Try to find the Schoology native header/nav bar and sit below it
            const navSelectors = [
                '#topbar', '#header', '.header', 'header',
                '[class*="topbar"]', '[class*="nav-bar"]', '[class*="app-header"]',
                '[role="banner"]'
            ];
            for (const sel of navSelectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetHeight > 0) {
                    return el.getBoundingClientRect().bottom + 'px';
                }
            }
            return '50px'; // safe fallback
        }

        init() {1
            if (!this.isGradePage()) {
                return;
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setup());
            } else {
                this.setup();
            }
        }

        isGradePage() {
            const url = window.location.href;
            return url.includes('grades') && 
                   !url.includes('past=') && 
                   window.location.hostname.includes('schoology.com');
        }

        setup() {
            this.detectMarkingPeriod();
            this.extractCourseData();
            this.createDashboard();
            this.setupMenuDetection();
        }

        detectMarkingPeriod() {
            console.log('=== Starting MP Detection ===');
            
            // Strategy: Find which MP date range contains today's date
            const today = new Date();
            const mpSections = new Map();
            
            // First pass: Find all MP headers and extract date ranges
            const allElements = Array.from(document.querySelectorAll('*'));
            
            for (let i = 0; i < allElements.length; i++) {
                const element = allElements[i];
                const text = element.textContent?.trim();
                if (!text) continue;
                
                // Match: "MP 2 2025-2026" format
                const mpMatch = text.match(/^MP\s*(\d+)\s*(\d{4})-(\d{4})/);
                if (mpMatch) {
                    const mpNumber = parseInt(mpMatch[1]);
                    const mp = `MP${mpNumber}`;
                    const startYear = parseInt(mpMatch[2]);
                    const endYear = parseInt(mpMatch[3]);
                    
                    // Estimate MP date ranges based on typical school year quarters
                    // MP1: Aug-Oct, MP2: Nov-Jan, MP3: Feb-Mar, MP4: Apr-Jun
                    let startMonth, endMonth, yearForStart, yearForEnd;
                    
                    if (mpNumber === 1) {
                        startMonth = 8; // August
                        endMonth = 10; // October
                        yearForStart = startYear;
                        yearForEnd = startYear;
                    } else if (mpNumber === 2) {
                        startMonth = 11; // November
                        endMonth = 1; // January
                        yearForStart = startYear;
                        yearForEnd = endYear;
                    } else if (mpNumber === 3) {
                        startMonth = 2; // February
                        endMonth = 3; // March
                        yearForStart = endYear;
                        yearForEnd = endYear;
                    } else if (mpNumber === 4) {
                        startMonth = 4; // April
                        endMonth = 6; // June
                        yearForStart = endYear;
                        yearForEnd = endYear;
                    }
                    
                    const startDate = new Date(yearForStart, startMonth - 1, 1);
                    const endDate = new Date(yearForEnd, endMonth, 0); // Last day of month
                    
                    const isCurrentPeriod = today >= startDate && today <= endDate;
                    
                    // Look ahead for assignment indicators
                    let hasAssignments = false;
                    let assignmentCount = 0;
                    
                    for (let j = i + 1; j < Math.min(i + 50, allElements.length); j++) {
                        const nextEl = allElements[j];
                        const nextText = nextEl.textContent?.trim();
                        
                        // Stop if we hit another MP header
                        if (nextText && nextText.match(/^MP\s*\d+\s*\d{4}-\d{4}/)) {
                            break;
                        }
                        
                        // Check for assignment indicators
                        if (nextText && (
                            nextText.match(/^(Minor|Major|Practice)\s*\(\d+%\)/) ||
                            nextText.includes('Missing') ||
                            nextText.match(/\d+\/\d+\/\d+\s+\d+:\d+/)
                        )) {
                            hasAssignments = true;
                            assignmentCount++;
                        }
                    }
                    
                    if (!mpSections.has(mp) || assignmentCount > (mpSections.get(mp)?.assignmentCount || 0)) {
                        mpSections.set(mp, {
                            mp,
                            number: mpNumber,
                            hasAssignments,
                            assignmentCount,
                            isCurrentPeriod,
                            startDate: startDate.toLocaleDateString(),
                            endDate: endDate.toLocaleDateString(),
                            element,
                            text: text.substring(0, 100)
                        });
                    }
                }
            }
            
            console.log('MP Sections found:', Array.from(mpSections.values()));
            
            // Prioritize: 1) Current period by date, 2) MP with most assignments
            const currentPeriods = Array.from(mpSections.values()).filter(m => m.isCurrentPeriod);
            console.log('Current periods by date:', currentPeriods);
            
            if (currentPeriods.length > 0) {
                const selected = currentPeriods[0];
                this.currentMarkingPeriod = selected.mp;
                console.log('Selected MP (current by date):', selected);
                console.log('=== MP Detection Complete ===');
                return;
            }
            
            // Fallback: Select MP with most assignments
            const mpsWithAssignments = Array.from(mpSections.values()).filter(m => m.hasAssignments);
            console.log('MPs with assignments:', mpsWithAssignments);
            
            if (mpsWithAssignments.length > 0) {
                const selected = mpsWithAssignments.sort((a, b) => {
                    if (b.assignmentCount !== a.assignmentCount) {
                        return b.assignmentCount - a.assignmentCount;
                    }
                    return a.number - b.number;
                })[0];
                
                this.currentMarkingPeriod = selected.mp;
                console.log('Selected MP (has assignments):', selected);
                console.log('=== MP Detection Complete ===');
                return;
            }
            
            // Fallback: Use lowest MP number found
            if (mpSections.size > 0) {
                const selected = Array.from(mpSections.values()).sort((a, b) => a.number - b.number)[0];
                this.currentMarkingPeriod = selected.mp;
                console.log('Selected MP (fallback to lowest):', selected);
                console.log('=== MP Detection Complete ===');
                return;
            }
            
            // Default to MP1 if nothing detected
            this.currentMarkingPeriod = 'MP1';
            console.log('Selected MP (default): MP1');
            console.log('=== MP Detection Complete ===');
        }

        extractCourseData() {
            // Find course links
            let courseLinks = document.querySelectorAll('a[href*="/course/"]');
            
            if (courseLinks.length === 0) {
                courseLinks = document.querySelectorAll('.gradebook-course-title a, h2 a, h3 a');
            }
            
            const courseNames = [];
            courseLinks.forEach((link) => {
                const courseText = link.textContent.trim();
                const cleanText = courseText.split('(')[0].trim().replace(/Course$/, '').trim();
                if (cleanText && cleanText.length > 2) {
                    courseNames.push(cleanText);
                }
            });
            
            // Extract grades and assignments - use a Map to deduplicate by course name
            const courseMap = new Map();
            let currentCourseIndex = -1;
            let currentMP = null;
            let inPracticeCategory = false;
            const allElements = document.querySelectorAll('*');
            
            for (const element of allElements) {
                const text = element.textContent?.trim();
                if (!text) continue;
                
                // Check if this is a course link
                if ((element.tagName === 'A' && element.closest('.gradebook-course-title, h2, h3')) ||
                    element.classList.contains('gradebook-course-title')) {
                    
                    const courseText = text.split('(')[0].trim().replace(/Course$/, '').trim();
                    const matchIndex = courseNames.indexOf(courseText);
                    
                    if (matchIndex >= 0) {
                        currentCourseIndex = matchIndex;
                    }
                }
                
                // Check if this is a marking period header with grade
                const mpMatch = text.match(/MP\s*(\d+)\s*\d{4}-\d{4}/);
                if (mpMatch && currentCourseIndex >= 0) {
                    currentMP = `MP${mpMatch[1]}`;
                    const currentCourse = courseNames[currentCourseIndex];
                    inPracticeCategory = false; // Reset when entering new MP
                    
                    const gradeMatch = text.match(/([A-F][+-]?)\s*\((\d+(?:\.\d+)?)%\)/);
                    
                    if (gradeMatch && currentCourse && currentMP === this.currentMarkingPeriod) {
                        const grade = gradeMatch[1];
                        const percentage = parseFloat(gradeMatch[2]);
                        
                        // Only add if not already in map, or update if this has more data
                        if (!courseMap.has(currentCourse)) {
                            courseMap.set(currentCourse, {
                                name: currentCourse,
                                grade: grade,
                                percentage: percentage,
                                missingAssignments: [],
                                submittedCount: 0,
                                concerningAssignments: []
                            });
                        }
                    }
                }
                
                // Check if this is a Practice category header
                if (text.match(/^Practice\s*Category/i) && currentCourseIndex >= 0 && currentMP === this.currentMarkingPeriod) {
                    inPracticeCategory = true;
                    console.log('✓ Entered Practice category for course:', courseNames[currentCourseIndex]);
                }
                
                // Check if we're leaving Practice category (entering another category or MP)
                if (inPracticeCategory && (
                    text.match(/^(Minor|Major)\s*Category/i) ||
                    text.match(/^MP\s*\d+\s*\d{4}-\d{4}/) ||
                    text.match(/^Final\s+Exam\s+Semester/i) ||
                    text.match(/^Course\s+Grade/i)
                )) {
                    inPracticeCategory = false;
                    console.log('✓ Exited Practice category');
                }
                
                // Check if this is an assignment row with "Missing" status
                if (element.tagName === 'TR' && currentCourseIndex >= 0 && currentMP === this.currentMarkingPeriod) {
                    const rowText = element.textContent;
                    const cells = element.querySelectorAll('th, td');
                    
                    if (cells.length > 0) {
                        const firstCell = cells[0];
                        const assignmentText = firstCell.textContent.trim();
                        const lines = assignmentText.split('\n').map(l => l.trim()).filter(l => l);
                        
                        // Check for submitted indicator
                        const rowHTML = element.innerHTML;
                        const gradeCell = element.querySelector('.grade-column, td:nth-child(2), td:nth-child(3)');
                        const gradeCellHTML = gradeCell ? gradeCell.innerHTML : '';
                        const gradeCellText = gradeCell ? gradeCell.textContent.trim() : '';
                        
                        const hasSubmittedIcon = gradeCellHTML.includes('grade-pending-icon') || 
                                                gradeCellHTML.includes('has-dropbox-icon') ||
                                                rowHTML.includes('grade-pending-icon') ||
                                                rowHTML.includes('has-dropbox-icon');
                        
                        // Also detect submission via accessible text in the grade cell
                        const hasSubmittedText = gradeCellText.includes('has made a submission') ||
                                                 gradeCellText.includes('has completed assignment submission') ||
                                                 gradeCellText.includes('has completed the test') ||
                                                 gradeCellText.includes('has posted in the discussion');

                        const isSubmitted = hasSubmittedIcon || hasSubmittedText;
                        
                        // Check for failing grade (E or F)
                        const failingGradeMatch = gradeCellText.match(/([EF])\s*(\d+)\s*\/\s*(\d+)/);
                        
                        console.log('Assignment row:', {
                            assignment: lines[0],
                            allLines: lines,
                            hasIcon: hasSubmittedIcon,
                            isSubmitted: isSubmitted,
                            gradeCellText: gradeCellText,
                            failingGrade: failingGradeMatch ? `${failingGradeMatch[1]} ${failingGradeMatch[2]}/${failingGradeMatch[3]}` : null
                        });
                        
                        if (lines.length > 0) {
                            let assignmentName = lines[0];
                            const currentCourse = courseNames[currentCourseIndex];
                            
                            // Strip existing date/time from assignment name (format: "Due MM/DD/YY HH:MMam/pm")
                            assignmentName = assignmentName.replace(/\s+Due\s+\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}:\d{2}(am|pm)/i, '').trim();
                            
                            // Extract just MM/DD from the lines
                            let shortDate = '';
                            for (const line of lines) {
                                const dateMatch = line.match(/(\d{1,2})\/(\d{1,2})\/\d{2}/);
                                if (dateMatch) {
                                    shortDate = `${dateMatch[1]}/${dateMatch[2]}`;
                                    break;
                                }
                            }
                            
                            // Handle failing grades
                            if (failingGradeMatch) {
                                const letterGrade = failingGradeMatch[1];
                                const points = failingGradeMatch[2];
                                const maxPoints = failingGradeMatch[3];
                                const percentage = maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0;
                                
                                const fullAssignment = shortDate ? `${assignmentName} Due ${shortDate} ${percentage}%` : `${assignmentName} ${percentage}%`;
                                
                                let course = courseMap.get(currentCourse);
                                if (!course) {
                                    course = {
                                        name: currentCourse,
                                        grade: '—',
                                        percentage: null,
                                        missingAssignments: [],
                                        submittedCount: 0,
                                        concerningAssignments: []
                                    };
                                    courseMap.set(currentCourse, course);
                                }
                                course.concerningAssignments.push(fullAssignment);
                                console.log('✓ Detected concerning assignment:', fullAssignment);
                            }
                            // Handle missing assignments
                            else if (rowText.includes('Missing') && !rowText.includes('Exempt')) {
                                // Skip if the student has already submitted — it's just awaiting a grade
                                if (isSubmitted) {
                                    console.log('⊘ Skipped missing (already submitted):', assignmentName);
                                } else {
                                    const fullAssignment = shortDate ? `${assignmentName} Due ${shortDate}` : assignmentName;
                                    
                                    if (assignmentName && assignmentName !== 'Missing' && assignmentName.length > 0) {
                                        let course = courseMap.get(currentCourse);
                                        if (!course) {
                                            course = {
                                                name: currentCourse,
                                                grade: '—',
                                                percentage: null,
                                                missingAssignments: [],
                                                submittedCount: 0,
                                                concerningAssignments: []
                                            };
                                            courseMap.set(currentCourse, course);
                                        }
                                        
                                        // If in Practice category, only add if course grade is below 80%
                                        if (inPracticeCategory) {
                                            if (course.percentage !== null && course.percentage < 80) {
                                                course.missingAssignments.push({ text: fullAssignment, isPractice: true });
                                                console.log('✓ Detected Practice missing (grade < 80%):', fullAssignment);
                                            } else {
                                                console.log('⊘ Skipped Practice missing (grade >= 80%):', fullAssignment);
                                            }
                                        } else {
                                            // Not in Practice category, always add
                                            course.missingAssignments.push({ text: fullAssignment, isPractice: false });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            // Convert courseMap to array
            this.courses = Array.from(courseMap.values());
        }

        createDashboard() {
            const existing = document.getElementById('parent-dashboard-lite');
            if (existing) {
                existing.remove();
            }

            const dashboard = document.createElement('div');
            dashboard.id = 'parent-dashboard-lite';
            dashboard.innerHTML = this.buildHTML();
            
            document.body.appendChild(dashboard);

            // Wire up the minimize button
            const minBtn = document.getElementById('pdl-minimize-btn');
            if (minBtn) {
                minBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleMinimize();
                });
            }

            // Apply initial minimized state without animation
            if (this.isMinimized) {
                this.applyMinimizedState(false);
            }
        }

        toggleMinimize() {
            this.isMinimized = !this.isMinimized;
            localStorage.setItem('pdl-minimized', this.isMinimized);
            this.applyMinimizedState(true);
        }

        applyMinimizedState(animate) {
            const panel = document.querySelector('#parent-dashboard-lite > div');
            const body = document.getElementById('pdl-body');
            const minBtn = document.getElementById('pdl-minimize-btn');
            if (!panel || !body || !minBtn) return;

            if (animate) {
                body.style.transition = 'max-height 0.3s ease, opacity 0.3s ease';
            } else {
                body.style.transition = 'none';
            }

            if (this.isMinimized) {
                if (this.mobile) {
                    // On mobile: collapse body but keep header visible just below the Schoology nav
                    panel.style.setProperty('top', this.getMobileTopOffset(), 'important');
                    panel.style.removeProperty('bottom');
                } else {
                    // On desktop: anchor minimized header to bottom-right
                    panel.style.setProperty('top', 'auto', 'important');
                    panel.style.setProperty('bottom', '20px', 'important');
                }
                panel.style.setProperty('max-height', 'none', 'important');
                panel.style.setProperty('overflow', 'visible', 'important');
                body.style.maxHeight = '0';
                body.style.opacity = '0';
                body.style.overflow = 'hidden';
                minBtn.textContent = '▲';
                minBtn.title = 'Expand dashboard';
            } else {
                if (this.mobile) {
                    const mobileTop = this.getMobileTopOffset();
                    panel.style.setProperty('top', mobileTop, 'important');
                    panel.style.removeProperty('bottom');
                    panel.style.setProperty('max-height', `calc(90vh - ${mobileTop})`, 'important');
                } else {
                    panel.style.setProperty('top', '100px', 'important');
                    panel.style.removeProperty('bottom');
                    panel.style.setProperty('max-height', 'calc(100vh - 100px)', 'important');
                }
                panel.style.setProperty('overflow-y', 'auto', 'important');
                body.style.maxHeight = '';
                body.style.opacity = '';
                body.style.overflow = '';
                minBtn.textContent = '▼';
                minBtn.title = 'Minimize dashboard';
            }
        }

        setupMenuDetection() {
            // Menu detection only relevant on desktop — on mobile the panel is full-width at top
            if (this.mobile) {
                // On mobile: watch for dropdowns and lower dashboard z-index so they render on top
                const checkMobileMenu = () => {
                    const panel = document.querySelector('#parent-dashboard-lite > div');
                    if (!panel) return;

                    const menuSelectors = [
                        '[class*="dropdown-menu"]:not([style*="display: none"])',
                        '.dropdown.open .dropdown-menu',
                        '.show .dropdown-menu',
                        '[role="menu"]',
                        '[class*="user-dropdown"]',
                        '[class*="popover"]'
                    ];

                    let isMenuOpen = false;
                    for (const selector of menuSelectors) {
                        const menu = document.querySelector(selector);
                        if (menu && menu.offsetParent !== null) {
                            isMenuOpen = true;
                            break;
                        }
                    }
                    // Also check aria-expanded
                    const expanded = document.querySelector('[aria-expanded="true"]');
                    if (expanded) isMenuOpen = true;

                    if (isMenuOpen) {
                        // Drop below the dropdown so it's fully visible
                        panel.style.setProperty('z-index', '999', 'important');
                    } else {
                        panel.style.setProperty('z-index', '10000', 'important');
                    }
                };

                const observer = new MutationObserver(checkMobileMenu);
                observer.observe(document.body, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ['class', 'style', 'aria-expanded']
                });
                document.addEventListener('click', () => {
                    setTimeout(checkMobileMenu, 50);
                    setTimeout(checkMobileMenu, 300);
                });
                return;
            }
            const checkMenu = () => {
                const dashboard = document.getElementById('parent-dashboard-lite');
                if (!dashboard) return;
                
                // Get the actual content div (first child)
                const contentDiv = dashboard.firstElementChild;
                if (!contentDiv) return;
                
                // Look for various menu selectors that might indicate the dropdown is open
                const menuSelectors = [
                    '[class*="dropdown-menu"][style*="display: block"]',
                    '[class*="dropdown-menu"]:not([style*="display: none"])',
                    '[class*="user-menu"][style*="display: block"]',
                    '[aria-expanded="true"] + [class*="dropdown"]',
                    '[aria-expanded="true"] + [class*="menu"]',
                    '.dropdown.open .dropdown-menu',
                    '.show .dropdown-menu',
                    '[class*="popover"]',
                    '[role="menu"]',
                    '[class*="user-dropdown"]'
                ];
                
                let isMenuOpen = false;
                let foundMenu = null;
                
                for (const selector of menuSelectors) {
                    const menu = document.querySelector(selector);
                    if (menu && menu.offsetParent !== null) {
                        isMenuOpen = true;
                        foundMenu = selector;
                        break;
                    }
                }
                
                // Also check for aria-expanded on user button
                const userButton = document.querySelector('[class*="user"], button[aria-expanded="true"]');
                if (userButton && userButton.getAttribute('aria-expanded') === 'true') {
                    isMenuOpen = true;
                    foundMenu = 'aria-expanded button';
                }
                
                console.log('Menu check:', { isMenuOpen, foundMenu, currentRight: contentDiv.style.right });
                
                // Slide dashboard left so it doesn't overlap the open dropdown
                if (isMenuOpen) {
                    // Find the open menu element to measure its left edge
                    let openMenu = null;
                    for (const selector of menuSelectors) {
                        const menu = document.querySelector(selector);
                        if (menu && menu.offsetParent !== null) {
                            openMenu = menu;
                            break;
                        }
                    }

                    let rightOffset = 280; // fallback if we can't measure
                    if (openMenu) {
                        const menuRect = openMenu.getBoundingClientRect();
                        const viewportWidth = window.innerWidth;
                        const dashboardWidth = contentDiv.offsetWidth || 360;
                        const gap = 12; // px clearance between dashboard right edge and menu left edge
                        // right = viewportWidth - menuRect.left + gap
                        const needed = viewportWidth - menuRect.left + gap;
                        rightOffset = Math.max(needed, 20); // never go below default
                        console.log('Menu rect:', menuRect, 'computed rightOffset:', rightOffset);
                    }

                    contentDiv.style.setProperty('right', `${rightOffset}px`, 'important');
                    contentDiv.style.setProperty('z-index', '9999', 'important');
                    contentDiv.style.setProperty('transition', 'right 0.3s ease', 'important');
                } else {
                    contentDiv.style.setProperty('right', '20px', 'important');
                    contentDiv.style.setProperty('z-index', '10000', 'important');
                    contentDiv.style.setProperty('transition', 'right 0.3s ease', 'important');
                }
            };
            
            // Check immediately
            checkMenu();
            
            // Use MutationObserver to watch for changes
            const observer = new MutationObserver(checkMenu);
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'aria-expanded']
            });
            
            // Also listen for all clicks to catch menu toggles
            document.addEventListener('click', (e) => {
                console.log('Click detected on:', e.target);
                setTimeout(checkMenu, 50);
                setTimeout(checkMenu, 200);
            });
            
            // Listen for escape key (often closes menus)
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    setTimeout(checkMenu, 50);
                }
            });
        }

        buildHTML() {
            const totalMissing = this.courses.reduce((sum, course) => sum + course.missingAssignments.length, 0);
            const avgGrade = this.calculateAverageGrade();
            const m = this.mobile;

            const mobileTop = this.mobile ? this.getMobileTopOffset() : '100px';

            // Mobile: full-width overlay pinned below the Schoology nav bar, larger everything
            // Desktop: fixed side panel as before
            const panelStyle = m
                ? `position: fixed; top: ${mobileTop}; left: 0; right: 0; width: 100%; max-width: 100%;
                   background: white; border: none; border-radius: 0 0 12px 12px;
                   box-shadow: 0 4px 24px rgba(0,0,0,0.25);
                   z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                   font-size: 16px; max-height: calc(90vh - ${mobileTop}); overflow-y: auto;`
                : `position: fixed; top: 100px; right: 20px; width: 360px; background: white;
                   border: 1px solid #d1d5da; border-radius: 8px; box-shadow: 0 8px 24px rgba(149, 157, 165, 0.2);
                   z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                   font-size: 14px; max-height: calc(100vh - 100px); overflow-y: auto;`;

            const headerPadding   = m ? '20px 24px' : '16px 20px';
            const titleSize       = m ? '22px' : '18px';
            const subtitleSize    = m ? '14px' : '12px';
            const btnSize         = m ? '40px' : '28px';
            const btnFontSize     = m ? '18px' : '13px';
            const summaryPadding  = m ? '20px 24px' : '16px 20px';
            const summaryNumSize  = m ? '32px' : '24px';
            const summaryLblSize  = m ? '13px' : '11px';
            const summaryPad      = m ? '16px' : '12px';
            const coursePad       = m ? '20px 24px' : '16px 20px';

            return `
                <div style="${panelStyle}">
                    <!-- Header -->
                    <div style="padding: ${headerPadding}; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                color: white; border-radius: ${m ? '0' : '8px 8px 0 0'};
                                display: flex; align-items: center; justify-content: space-between;">
                        <div>
                            <h2 style="margin: 0; font-size: ${titleSize}; font-weight: 600;">📊 Parent Dashboard Lite</h2>
                            <div style="font-size: ${subtitleSize}; opacity: 0.9; margin-top: 4px;">
                                ${this.currentMarkingPeriod}
                                <span style="margin-left: 10px; color: #86efac; font-weight: 600;">Version ${VERSION}</span>
                            </div>
                        </div>
                        <button id="pdl-minimize-btn" title="Minimize dashboard"
                            style="background: rgba(255,255,255,0.2); border: none; color: white; cursor: pointer;
                                   width: ${btnSize}; height: ${btnSize}; border-radius: 50%; font-size: ${btnFontSize}; font-weight: 700;
                                   display: flex; align-items: center; justify-content: center; flex-shrink: 0;
                                   transition: background 0.2s; line-height: 1; padding: 0; touch-action: manipulation;"
                            onmouseover="this.style.background='rgba(255,255,255,0.35)'"
                            onmouseout="this.style.background='rgba(255,255,255,0.2)'">▼</button>
                    </div>

                    <!-- Body (hidden when minimized) -->
                    <div id="pdl-body">
                        <!-- Summary -->
                        <div style="padding: ${summaryPadding}; border-bottom: 1px solid #e1e4e8; background: #f6f8fa;">
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div style="text-align: center; padding: ${summaryPad}; background: white; border-radius: 6px; border: 2px solid ${totalMissing > 0 ? '#fbbf24' : '#10b981'};">
                                    <div style="font-size: ${summaryNumSize}; font-weight: 700; color: ${totalMissing > 0 ? '#f59e0b' : '#059669'};">${totalMissing}</div>
                                    <div style="font-size: ${summaryLblSize}; color: #6b7280; text-transform: uppercase; font-weight: 600;">Missing</div>
                                </div>
                                <div style="text-align: center; padding: ${summaryPad}; background: white; border-radius: 6px; border: 2px solid #3b82f6;">
                                    <div style="font-size: ${summaryNumSize}; font-weight: 700; color: #2563eb;">${avgGrade}</div>
                                    <div style="font-size: ${summaryLblSize}; color: #6b7280; text-transform: uppercase; font-weight: 600;">Avg Grade</div>
                                </div>
                            </div>
                        </div>

                        <!-- Course List -->
                        <div style="padding: ${coursePad};">
                            ${this.buildCourseList()}
                        </div>
                    </div>
                </div>
            `;
        }

        buildCourseList() {
            if (this.courses.length === 0) {
                return '<div style="text-align: center; color: #6b7280; padding: 20px;">No course data available</div>';
            }

            const m = this.mobile;
            const courseNameSize  = m ? '15px' : '13px';
            const gradeLetterSize = m ? '30px' : '24px';
            const gradePctSize    = m ? '20px' : '16px';
            const sectionHdrSize  = m ? '14px' : '12px';
            const assignmentSize  = m ? '13px' : '11px';
            const coursePad       = m ? '14px 18px' : '12px 14px';
            const truncateLen     = m ? 32 : 28;

            return this.courses.map(course => {
                const gradeColor = this.getGradeColor(course.grade);
                const hasMissing = course.missingAssignments.length > 0;
                const hasConcerning = course.concerningAssignments.length > 0;
                
                return `
                    <div style="margin-bottom: 16px; padding: 0; background: white; 
                                border: 2px solid ${gradeColor}; border-radius: 6px; overflow: hidden;">
                        
                        <!-- Course Header -->
                        <div style="padding: ${coursePad}; background: ${hasMissing || hasConcerning ? '#fef3c7' : '#f9fafb'}; 
                                    border-bottom: 1px solid ${gradeColor}; display: flex; justify-content: space-between; align-items: center;">
                            <div style="font-weight: 600; color: #1f2937; font-size: ${courseNameSize}; flex: 1;">
                                ${this.truncate(course.name, truncateLen)}
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div style="font-size: ${gradeLetterSize}; font-weight: 700; color: ${gradeColor}; line-height: 1;">
                                    ${course.grade}
                                </div>
                                ${course.percentage !== null ? `
                                    <div style="font-size: ${gradePctSize}; color: #6b7280; font-weight: 600;">
                                        ${course.percentage}%
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                        
                        <!-- Missing Assignments -->
                        ${hasMissing ? `
                            <div style="padding: ${coursePad}; background: white; ${hasConcerning ? 'border-bottom: 1px solid #fde68a;' : ''}">
                                <div style="font-size: ${sectionHdrSize}; color: #7c2d12; font-weight: 800; margin-bottom: 6px;">
                                    ${course.missingAssignments.length} Missing Assignment${course.missingAssignments.length > 1 ? 's' : ''}
                                </div>
                                ${course.missingAssignments.slice(0, 5).map(a => `
                                    <div style="font-size: ${assignmentSize}; color: #78350f; margin-left: 12px; margin-top: ${m ? '5px' : '3px'}; line-height: 1.5; word-wrap: break-word; overflow-wrap: break-word;${a.isPractice ? ' font-style: italic;' : ''}">
                                        • ${a.isPractice ? '(P) ' : ''}${a.text}
                                    </div>
                                `).join('')}
                                ${course.missingAssignments.length > 5 ? `
                                    <div style="font-size: ${assignmentSize}; color: #78350f; margin-left: 12px; margin-top: 3px; font-style: italic;">
                                        +${course.missingAssignments.length - 5} more...
                                    </div>
                                ` : ''}
                            </div>
                        ` : ''}
                        
                        <!-- Concerning Assignments -->
                        ${hasConcerning ? `
                            <div style="padding: ${coursePad}; background: white;">
                                <div style="font-size: ${sectionHdrSize}; color: #991b1b; font-weight: 700; margin-bottom: 6px;">
                                    ${course.concerningAssignments.length} Concerning Assignment${course.concerningAssignments.length > 1 ? 's' : ''}
                                </div>
                                ${course.concerningAssignments.slice(0, 5).map(assignment => `
                                    <div style="font-size: ${assignmentSize}; color: #7f1d1d; margin-left: 12px; margin-top: ${m ? '5px' : '3px'}; line-height: 1.5; word-wrap: break-word; overflow-wrap: break-word;">
                                        • ${assignment}
                                    </div>
                                `).join('')}
                                ${course.concerningAssignments.length > 5 ? `
                                    <div style="font-size: ${assignmentSize}; color: #7f1d1d; margin-left: 12px; margin-top: 3px; font-style: italic;">
                                        +${course.concerningAssignments.length - 5} more...
                                    </div>
                                ` : ''}
                            </div>
                        ` : ''}
                        
                        <!-- No Issues -->
                        ${!hasMissing && !hasConcerning ? `
                            <div style="padding: ${coursePad}; background: white; text-align: center; color: #10b981; font-size: ${sectionHdrSize}; font-weight: 500;">
                                ✓ No missing assignments
                            </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
        }

        calculateAverageGrade() {
            const validGrades = this.courses.filter(c => c.percentage !== null);
            if (validGrades.length === 0) return '—';
            
            const avg = validGrades.reduce((sum, c) => sum + c.percentage, 0) / validGrades.length;
            return `${avg.toFixed(1)}%`;
        }

        getGradeColor(grade) {
            if (grade.startsWith('A')) return '#10b981';
            if (grade.startsWith('B')) return '#3b82f6';
            if (grade.startsWith('C')) return '#f59e0b';
            if (grade.startsWith('D')) return '#ef4444';
            if (grade.startsWith('F')) return '#dc2626';
            if (grade.startsWith('E')) return '#dc2626';
            return '#6b7280';
        }

        truncate(text, maxLength) {
            if (text.length <= maxLength) return text;
            return text.substring(0, maxLength - 3) + '...';
        }
    }

    // Initialize the dashboard
    const dashboard = new ParentDashboardLite();
    dashboard.init();
})();
