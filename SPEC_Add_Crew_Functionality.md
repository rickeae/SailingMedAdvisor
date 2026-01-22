# Specification: Add Crew Member Functionality
## Vessel & Crew Info Page

**Document Version:** 1.0  
**Date:** January 22, 2026  
**System:** SailingMedAdvisor v5.7

---

## 1. Overview

The Add Crew Member functionality allows users to register new crew members, passengers, or captain into the SailingMedAdvisor system. This feature is located on the **Vessel & Crew Info** tab within a collapsible "Add New Crew Member" section under "Crew Information".

---

## 2. User Interface Location

- **Primary Tab:** Vessel & Crew (4th tab in main navigation)
- **Parent Section:** Crew Information (collapsible)
- **Component:** Add New Crew Member (nested collapsible form)
- **UI State:** Initially collapsed (must be expanded to access)

---

## 3. Form Fields

### 3.1 Personal Information

| Field Name | Input Type | Required | Validation | Notes |
|------------|------------|----------|------------|-------|
| First Name | Text | Yes* | Non-empty after trim | Left column of 3-column grid |
| Middle Name(s) | Text | No | None | Center column of 3-column grid |
| Last Name | Text | Yes* | Non-empty after trim | Right column of 3-column grid |
| Sex | Dropdown | Yes* | Must select value | Options: Male, Female, Non-binary, Other, Prefer not to say |
| Birthdate | Date | Yes* | Must have value | Standard HTML date picker |
| Position | Dropdown | Yes* | Must select value | Options: Captain, Crew, Passenger |

### 3.2 Travel Documents

| Field Name | Input Type | Required | Validation | Notes |
|------------|------------|----------|------------|-------|
| Citizenship | Text + Datalist | Yes* | Non-empty after trim | Autocomplete suggestions from predefined country list |
| Passport Number | Text | Yes* | Non-empty after trim | Unique identifier |
| Issue Date | Date | No | None | Passport issue date |
| Expiry Date | Date | No | None | Passport expiration date |

**Country Datalist:** USA, Canada, UK, Australia, New Zealand, France, Germany, Spain, Italy, Netherlands, Singapore, Malaysia, Thailand, Philippines, Japan, China, India

### 3.3 Contact Information

| Field Name | Input Type | Required | Validation | Notes |
|------------|------------|----------|------------|-------|
| Cell/WhatsApp | Text | No | None | Placeholder format: +1234567890 |
| Passport Photo/PDF | File | No | Image/* or PDF, <5MB | Uploaded separately after crew creation |
| Passport Page Photo/PDF | File | No | Image/* or PDF, <5MB | Uploaded separately after crew creation |

### 3.4 Emergency Contact Information

| Field Name | Input Type | Required | Validation | Notes |
|------------|------------|----------|------------|-------|
| Name | Text | No | None | Emergency contact's full name |
| Relationship | Text | No | None | Relationship to crew member |
| Phone | Text | No | None | Emergency contact phone number |
| Email | Email | No | None | Emergency contact email address |
| Emergency Contact Notes | Text | No | None | Additional emergency contact information |

\* = Required field validation enforced

---

## 4. Functional Behavior

### 4.1 Add Operation Workflow

1. **User Input Phase:**
   - User expands "Crew Information" section (if collapsed)
   - User expands "Add New Crew Member" section (if collapsed)
   - User fills out form fields
   - User clicks "+ Add Crew Member" button

2. **Validation Phase:**
   ```javascript
   Required Field Checks (in order):
   1. First Name - Alert: "Please enter first name and last name"
   2. Last Name - Alert: "Please enter first name and last name"
   3. Sex - Alert: "Please select sex"
   4. Birthdate - Alert: "Please enter birthdate"
   5. Position - Alert: "Please select position"
   6. Citizenship - Alert: "Please enter citizenship"
   7. Passport Number - Alert: "Please enter passport number"
   ```
   - If any validation fails, display alert and stop processing
   - User must correct the issue and re-submit

3. **Data Creation Phase:**
   - Fetch existing crew data from `/api/data/patients`
   - Create new crew member object:
     ```javascript
     {
       id: Date.now().toString(),  // Timestamp-based unique ID
       firstName: string,
       middleName: string,
       lastName: string,
       sex: string,
       birthdate: string (YYYY-MM-DD),
       position: string,
       citizenship: string,
       passportNumber: string,
       passportIssue: string (YYYY-MM-DD),
       passportExpiry: string (YYYY-MM-DD),
       emergencyContactName: string,
       emergencyContactRelation: string,
       emergencyContactPhone: string,
       emergencyContactEmail: string,
       emergencyContactNotes: string,
       phoneNumber: string,
       passportPhoto: '',  // Empty initially
       passportPage: '',   // Empty initially
       history: ''         // Empty initially
     }
     ```

4. **Data Persistence Phase:**
   - Append new crew member to existing array
   - POST updated array to `/api/data/patients` endpoint
   - Server persists data to JSON file

5. **UI Update Phase:**
   - Clear all form fields (reset to empty/default state)
   - Call `loadData()` function to refresh UI
   - New crew member appears in:
     - Crew Information list (on current tab)
     - Crew Health & Log dropdown
     - Chat page crew member selector

---

## 5. Data Model

### 5.1 Storage Location
- **Endpoint:** `/api/data/patients`
- **Method:** GET (retrieve), POST (update)
- **Format:** JSON array
- **File:** `data/patients.json`

### 5.2 ID Generation
- **Algorithm:** `Date.now().toString()`
- **Format:** Unix timestamp as string (e.g., "1737522671234")
- **Uniqueness:** Guaranteed by millisecond precision
- **Note:** IDs are not sequential, time-based for traceability

---

## 6. Integration Points

### 6.1 Affected Components
1. **Crew Member Dropdown (Chat Page):**
   - New crew member added to `p-select` dropdown
   - Available for triage queries immediately

2. **Crew Medical List:**
   - New entry created with empty medical history
   - Accessible on "Crew Health & Log" tab

3. **Crew Information List:**
   - New collapsible section created
   - Shows crew member details with edit capability

### 6.2 Related Functions
- `loadCrewData()` - Refreshes all crew-dependent UI elements
- `getCrewDisplayName()` - Formats name as "Last, First"
- `getCrewFullName()` - Formats name as "First Last"
- `calculateAge()` - Calculates age from birthdate

---

## 7. User Experience Features

### 7.1 Form Behavior
- **Auto-trim:** All text fields automatically trimmed before save
- **Reset on Success:** Form clears completely after successful add
- **Datalist Support:** Citizenship field provides autocomplete suggestions
- **File Upload:** Document uploads handled separately after crew creation

### 7.2 Validation Feedback
- **Real-time:** No real-time validation (submit-time only)
- **Error Messages:** Alert-based, blocking further action until resolved
- **Field Focus:** No automatic focus on error field (manual user correction required)

---

## 8. Button Specification

### 8.1 Add Crew Member Button
- **Label:** "+ Add Crew Member"
- **Style:** 
  - Background: `var(--dark)` (#2c3e50)
  - Text: White
  - Width: 100% of container
  - Class: `btn btn-sm`
- **Action:** `onclick="addCrew()"`
- **Location:** Bottom of Add New Crew Member form

---

## 9. Edge Cases and Error Handling

### 9.1 Duplicate Detection
- **Current Behavior:** No duplicate detection
- **Allowed:** Multiple crew members with identical names
- **Recommendation:** Consider adding duplicate warning for same passport number

### 9.2 Network Failures
- **No Error Handling:** Function assumes successful API calls
- **Risk:** Silent failure if network or server issues occur
- **Recommendation:** Add try-catch blocks and user feedback

### 9.3 Concurrent Modifications
- **Race Condition:** Possible if multiple users add crew simultaneously
- **Mitigation:** Last-write-wins (later POST overwrites earlier)
- **Recommendation:** Implement server-side locking or conflict detection

---

## 10. Security Considerations

### 10.1 Input Sanitization
- **Client-side:** Basic HTML escaping via `escapeHtml()` on display
- **Server-side:** Assumed (not verified in frontend code)
- **File Uploads:** Size limit enforced (5MB), type validation (image/PDF)

### 10.2 Authentication
- **Current:** Uses `credentials: 'same-origin'` for API calls
- **Session-based:** Assumes server-side session validation
- **Login:** Crew-specific login credentials managed separately in Settings

---

## 11. Accessibility Notes

### 11.1 Current State
- **Labels:** Present for all form fields
- **Required Indicators:** Asterisk (*) in label text
- **Keyboard Navigation:** Standard HTML form tab order
- **Screen Reader:** Field labels associated with inputs

### 11.2 Improvements Needed
- **ARIA attributes:** Not currently implemented
- **Error announcements:** Alert dialogs are announced but could be improved
- **Focus management:** No automatic focus on validation errors

---

## 12. Performance Characteristics

### 12.1 Scalability
- **Data Structure:** Array-based, linear search for operations
- **Current Capacity:** Suitable for small crews (< 100 members)
- **Load Time:** O(n) where n = number of crew members
- **Recommendation:** Consider indexing for larger datasets

### 12.2 Network Efficiency
- **Data Transfer:** Full array sent on each POST (not incremental)
- **Bandwidth:** Minimal for typical crew sizes
- **Optimization:** Could implement PATCH for single crew updates

---

## 13. Testing Scenarios

### 13.1 Happy Path
1. Fill all required fields with valid data
2. Click "+ Add Crew Member"
3. Verify form clears
4. Verify crew appears in all relevant lists
5. Verify crew is selectable in chat dropdown

### 13.2 Validation Testing
1. Submit with each required field missing (one at a time)
2. Verify correct error message displayed
3. Verify form data retained after validation failure

### 13.3 Data Integrity
1. Add crew member
2. Refresh page
3. Verify crew member persists
4. Verify all fields saved correctly

### 13.4 Special Characters
1. Enter names with special characters (e.g., O'Brien, José)
2. Verify correct storage and display
3. Check CSV export format

---

## 14. Related Documentation

- **Main Application:** `app.py` - Backend API endpoints
- **Frontend Logic:** `static/js/crew.js` - Crew management functions
- **UI Template:** `templates/index.html` - Form structure
- **Data Schema:** `data/patients.json` - Sample data structure

---

## 15. Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-01-22 | Initial specification based on code analysis | System |

---

## 16. Future Enhancements

### 16.1 Potential Improvements
1. **Photo capture:** Direct camera integration for passport photos
2. **Barcode scanning:** Auto-fill from passport MRZ scan
3. **Duplicate detection:** Warning for similar names/passport numbers
4. **Batch import:** CSV import for multiple crew members
5. **Validation enhancement:** Real-time field validation
6. **Data export:** Individual crew member PDF dossier generation
7. **History tracking:** Audit log of crew member additions/changes

### 16.2 Integration Opportunities
1. **External APIs:** Passport validation services
2. **Compliance:** International maritime crew list standards (IMO FAL forms)
3. **Sync:** Cloud backup and multi-device synchronization
