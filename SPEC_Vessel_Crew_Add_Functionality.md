# Specification: Add Crew Member Functionality
## Vessel & Crew Info Page - SailingMedAdvisor

**Document Version:** 1.0  
**Last Updated:** January 22, 2026  
**Component:** Vessel & Crew Information Management

---

## Overview

The Add Crew Member functionality allows authorized users to register new crew members, passengers, or captain information into the SailingMedAdvisor system. This feature is located within the "Vessel & Crew Info" tab and provides a comprehensive data entry form for capturing essential crew information, documentation, and emergency contacts.

---

## Location & Access

**Navigation Path:**  
Main Navigation Bar → **VESSEL & CREW** tab → Crew Information section → **Add New Crew Member** (expandable section)

**Access Control:**  
- Requires user authentication (session-based)
- Available to all authenticated users
- No role-based restrictions currently implemented

---

## User Interface Components

###  1. Collapsible Section Header

**Element:** `div.col-header.crew-med-header`  
**Default State:** Collapsed (▸ icon)  
**Interactive Element:** Clickable header with toggle icon  
**Visual Indicator:** Arrow icon (▸ when collapsed, ▾ when expanded)

**Header Text:** "Add New Crew Member"

**Behavior:**
- Single-click toggles expansion/collapse
- Icon rotates to indicate current state
- State persists using localStorage with key based on `data-sidebar-id="crew-add"`

---

### 2. Input Form Fields

The add crew form is organized into logical grouped sections with a responsive grid layout.

#### **2.1 Name Fields**
**Layout:** 3-column grid (`grid-template-columns: 1fr 1fr 1fr`)

| Field Label | Element ID | Type | Required | Placeholder | Notes |
|------------|-----------|------|----------|-------------|--------|
| First Name | `cn-first` | text | Yes (*) | - | Primary identifier |
| Middle Name(s) | `cn-middle` | text | No | - | Optional middle names |
| Last Name | `cn-last` | text | Yes (*) | - | Family name |

#### **2.2 Personal Information**
**Layout:** 3-column grid

| Field Label | Element ID | Type | Required | Options/Format | Notes |
|------------|-----------|------|----------|----------------|--------|
| Sex | `cn-sex` | select | Yes (*) | Male, Female, Non-binary, Other, Prefer not to say | Gender identity |
| Birthdate | `cn-birthdate` | date | Yes (*) | YYYY-MM-DD | Age calculation base |
| Position | `cn-position` | select | Yes (*) | Captain, Crew, Passenger | Role aboard vessel |

#### **2.3 Documentation Fields**
**Layout:** 4-column grid

| Field Label | Element ID | Type | Required | Format/List | Notes |
|------------|-----------|------|----------|-------------|--------|
| Citizenship | `cn-citizenship` | text + datalist | Yes (*) | Country names | Autocomplete enabled |
| Passport Number | `cn-passport` | text | Yes (*) | Alphanumeric | Official passport ID |
| Issue Date | `cn-pass-issue` | date | No | YYYY-MM-DD | Passport issue |
| Expiry Date | `cn-pass-expiry` | date | No | YYYY-MM-DD | Passport expiration |

**Datalist Options** (id="countries"):  
USA, Canada, UK, Australia, New Zealand, France, Germany, Spain, Italy, Netherlands, Singapore, Malaysia, Thailand, Philippines, Japan, China, India

#### **2.4 Contact & File Upload**
**Layout:** 3-column grid (contact) + single row (files)

| Field Label | Element ID | Type | Required | Format | Notes |
|------------|-----------|------|----------|--------|--------|
| Cell/WhatsApp | `cn-phone` | text | No | +[country][number] | International format |
| Passport Photo/PDF | `cn-passport-photo` | file | No | image/*,.pdf | Photo upload |
| Passport Page Photo/PDF | `cn-passport-page` | file | No | image/*,.pdf | Document scan |

#### **2.5 Emergency Contact Section**
**Sub-header:** "Emergency Contact"  
**Layout:** 4-column grid + notes field

| Field Label | Element ID | Type | Required | Format | Notes |
|------------|-----------|------|----------|--------|--------|
| Name | `cn-emerg-name` | text | No | Full name | Contact person |
| Relationship | `cn-emerg-rel` | text | No | e.g., Spouse, Parent | Relation to crew |
| Phone | `cn-emerg-phone` | text | No | Phone number | Contact number |
| Email | `cn-emerg-email` | email | No | email@domain.com | Email address |
| Emergency Contact Notes | `cn-emerg-notes` | text | No | Additional info | Full-width field |

---

### 3. Action Button

**Element:** `<button onclick="addCrew()">`  
**Class:** `btn btn-sm`  
**Style:** `background:var(--dark); width:100%;`  
**Text:** "+ Add Crew Member"

**Visual Properties:**
- Dark background color (CSS variable: `--dark` = `#2c3e50`)
- Full width of container
- Small button sizing (`btn-sm` = `padding: 6px 12px; font-size: 13px`)
- White text color
- Pointer cursor on hover
- Transition effects on interaction

---

## Functional Behavior

### 1. Form Submission Process

**Trigger:** Click on "+ Add Crew Member" button  
**Handler Function:** `addCrew()` (defined in `/static/js/crew.js`)

**Execution Flow:**

1. **Data Collection**
   - Reads all input field values by element ID
   - Reads file uploads (if any)
   - Constructs crew member object

2. **Validation**
   - Checks required fields (marked with *)
   - First Name, Last Name, Sex, Birthdate, Position, Citizenship, and Passport Number are mandatory
   - Displays browser alert if required fields are missing
   - Validation message format: "Please fill in: First Name, Last Name, Sex, Birthdate, Position, Citizenship, Passport Number."

3. **File Handling**
   - Processes uploaded passport photo/PDF files
   - Stores file references or base64 encoded data
   - Associates files with crew member record

4. **API Request**
   ```javascript
   POST /api/data/patients
   Headers: { credentials: 'same-origin' }
   Content-Type: application/json
   Body: [updated patients array including new crew member]
   ```

5. **Response Handling**
   - **Success (200 OK):**
     - Displays success alert
     - Clears all form fields
     - Reloads crew list display (`loadData()`)
     - Collapses the Add New Crew Member section
   
   - **Failure (non-200):**
     - Displays error alert with message
     - Retains form data for correction
     - Does not clear form fields

6. **UI Updates**
   - Updates crew member dropdown in chat interface (`#p-select`)
   - Updates crew list display in Crew Information section
   - Updates crew list in Crew Health & Log tab
   - Refreshes crew credentials (if username/password set)

---

### 2. Data Structure

**Stored Object Format:**
```javascript
{
  "firstName": string,
  "middleName": string | "",
  "lastName": string,
  "name": string,  // Computed: "firstName middleName lastName"
  "sex": string,   // "Male" | "Female" | "Non-binary" | "Other" | "Prefer not to say"
  "birthdate": string,  // "YYYY-MM-DD"
  "position": string,   // "Captain" | "Crew" | "Passenger"
  "citizenship": string,
  "passportNumber": string,
  "passportIssueDate": string | "",    // "YYYY-MM-DD"
  "passportExpiryDate": string | "",   // "YYYY-MM-DD"
  "phone": string | "",
  "passportPhoto": string | null,      // File reference or base64
  "passportPage": string | null,       // File reference or base64
  "emergencyContact": {
    "name": string | "",
    "relationship": string | "",
    "phone": string | "",
    "email": string | "",
    "notes": string | ""
  },
  "history": string | "",              // Medical history notes
  "username": string | "",             // Optional login credential
  "password": string | ""              // Optional login credential
}
```

**Storage Location:**  
`/data/patients.json` (server-side file storage)

**Data Persistence:**  
- Written to disk immediately upon successful API call
- Loaded on page initialization and tab navigation
- Cached in browser session until page reload

---

### 3. Form Field Clearing

After successful submission, all form fields are reset:

```javascript
document.getElementById('cn-first').value = '';
document.getElementById('cn-middle').value = '';
document.getElementById('cn-last').value = '';
// ... (all fields cleared to empty string)
document.getElementById('cn-passport-photo').value = '';
document.getElementById('cn-passport-page').value = '';
```

---

### 4. Integration Points

#### **4.1 Patient Selection Dropdown**
- Location: MEDGEMMA CHAT tab → "Crew Member Receiving Care"
- Element ID: `#p-select`
- Auto-populates with format: "LastName, FirstName"
- Includes default option: "Unnamed Crew"
- Updates immediately after adding new crew member

#### **4.2 Crew Information List**
- Location: VESSEL & CREW tab → Crew Information section
- Container ID: `#crew-info-list`
- Displays all registered crew members as expandable cards
- Each card shows:
  - Name and position
  - Basic details (birthdate, citizenship, passport)
  - Emergency contact information
  - Edit and Delete action buttons

#### **4.3 Crew Health & Log**
- Location: CREW HEALTH & LOG tab
- Container ID: `#crew-medical-list`
- Shows crew members with medical history entries
- Allows adding medical notes per crew member

#### **4.4 Login Credentials**
- Location: SETTINGS tab → Crew Login Credentials
- Displays crew members who have username/password set
- Enables authentication for restricted access

---

## CSS Styling

### Form Container Styles

```css
.col-body {
    padding: 15px;
    background: #f8f9fa;
    display: none;  /* Initially collapsed */
}
```

### Grid Layout

```css
display: grid;
grid-template-columns: 1fr 1fr 1fr;  /* 3-column for names */
grid-template-columns: 1fr 1fr 1fr 1fr;  /* 4-column for docs/contact */
gap: 8px;
margin-bottom: 8px;
font-size: 15px;
```

### Input Field Styles

```css
input, select, textarea {
    padding: 6px;
    width: 100%;
    font-size: 15px;
}

label {
    font-size: 13px;
    margin-bottom: 2px;
    display: block;
}
```

### Button Styles

```css
.btn-sm {
    padding: 6px 12px;
    font-size: 13px;
    background: var(--dark);  /* #2c3e50 */
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
}
```

---

## Error Handling

### Client-Side Validation Errors

**Missing Required Fields:**
```
Alert Message: "Please fill in: [list of missing fields]"
Behavior: Form remains open, data retained, focus on first missing field
```

**File Upload Errors:**
```
Alert Message: "Error uploading files: [error description]"
Behavior: Form remains open, previously entered data retained
```

### Server-Side Errors

**API Request Failure:**
```
Alert Message: "Failed to add crew member: [HTTP status or error message]"
Behavior: Form remains open, all data retained for retry
```

**Network Error:**
```
Alert Message: "Network error. Please check your connection and try again."
Behavior: Form remains open, all data retained
```

---

## Accessibility Features

- **Keyboard Navigation:** Full tab-through support for all form fields
- **Screen Reader Support:** Proper label associations via `<label>` elements
- **Required Field Indicators:** Asterisk (*) in field labels
- **Focus Management:** First field receives focus when section expands
- **Error Messaging:** Clear, descriptive error messages for validation failures

---

## Security Considerations

1. **Authentication:** Requires active session (cookie-based)
2. **Data Validation:** Server-side validation of all inputs
3. **File Upload Security:**  
   - Restricted to image/* and .pdf MIME types
   - File size limits enforced server-side
   - Sanitized file names

4. **XSS Prevention:** All user inputs are escaped before rendering
5. **CSRF Protection:** SessionMiddleware with same-site=lax policy

---

## Performance Considerations

- **Form Load Time:** < 100ms (minimal DOM manipulation)
- **API Response Time:** Typically < 500ms for add operation
- **File Upload:** Dependent on file size and connection speed
- **Data Reload:** Full crew list refresh after successful addition

---

## Browser Compatibility

- **Tested Browsers:** Chrome, Firefox, Edge, Safari
- **Required Features:**
  - ES6+ JavaScript support
  - Fetch API
  - LocalStorage
  - HTML5 form inputs (date, email, file)
  - CSS Grid Layout

---

## Related Documentation

- Backend API: `/api/data/patients` endpoint specification
- Crew Management Module: `/static/js/crew.js`
- Data Storage: `/data/patients.json` format specification
- Authentication: Session management and login flow

---

## Known Issues & Limitations

1. **File Storage:** Currently stores base64 encoded files in JSON (may cause performance issues with large files)
2. **Validation:** Phone number format validation is not enforced
3. **Duplicate Prevention:** No check for duplicate passport numbers or names
4. **Photo Preview:** Uploaded photos are not previewed before submission
5. **Internationalization:** Form labels and messages are English-only

---

## Future Enhancements

- Photo preview before submission
- Duplicate detection (passport number, name)
- International phone number validation
- Multi-language support
- Batch import from CSV/Excel
- Photo compression before upload
- Separate file storage system (not embedded in JSON)
- Auto-save draft functionality
- Field-level inline validation

---

**End of Specification**
