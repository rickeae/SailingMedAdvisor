# Code Refactoring Documentation

## Overview
The codebase has been refactored to improve maintainability and enable easier team collaboration by splitting monolithic files into smaller, focused modules.

## Structure Changes

### Frontend JavaScript (Before → After)

**Before:**
- `templates/index.html` - ~900 lines (HTML + CSS + JavaScript all in one file)

**After:**
```
static/js/
├── main.js       - Core utilities, navigation, data loading (~110 lines)
├── chat.js       - Triage/Inquiry chat functionality (~110 lines)
├── crew.js       - Crew management, CRUD operations (~490 lines)
├── pharmacy.js   - Medicine inventory management (~190 lines)
├── settings.js   - Configuration management (~10 lines)
└── vessel.js     - Vessel information (~25 lines)
```

### Benefits

1. **Parallel Development**: Multiple developers can work on different features without merge conflicts
   - Developer A: Works on `crew.js` (crew page features)
   - Developer B: Works on `pharmacy.js` (inventory features)

2. **Code Organization**: Each file has a single responsibility
   - Easier to locate and fix bugs
   - Clearer code structure
   - Better separation of concerns

3. **Maintainability**: Smaller files are easier to understand and modify
   - Average file size: ~150 lines (vs 900+ lines before)
   - Focused functionality per module

4. **Reusability**: Shared utilities in `main.js` can be used across modules

## Module Descriptions

### main.js
- Toggle functions for collapsible sections
- Tab navigation (`showTab`)
- Central data loading (`loadData`)
- Tools and history display functions
- Window initialization

### chat.js
- Chat state management (isPrivate, lastPrompt, isProcessing)
- UI update functions (`updateUI`, `togglePriv`)
- Chat execution (`runChat`, `repeatLast`)
- Enter key handler for message submission

### crew.js
- Crew display and sorting logic
- CRUD operations (add, auto-save, delete)
- Emergency contact management
- Document upload/delete (passport photos)
- Import/export functionality
- Crew list CSV generation

### pharmacy.js
- Medicine inventory display
- Add/save/delete medicine operations
- CSV import/export functionality
- Category and controlled substance handling

### settings.js
- Configuration save functionality
- Settings synchronization with backend

### vessel.js
- Vessel information save/load operations

## File Loading Order

The modules are loaded in this specific order in `index.html`:
```html
<script src="/static/js/chat.js"></script>
<script src="/static/js/crew.js"></script>
<script src="/static/js/pharmacy.js"></script>
<script src="/static/js/settings.js"></script>
<script src="/static/js/vessel.js"></script>
<script src="/static/js/main.js"></script>  <!-- Last - initializes the app -->
```

**Important**: `main.js` must load last because it contains `window.onload` which calls functions from other modules.

## Development Workflow

### Working on Crew Features
1. Edit `static/js/crew.js`
2. Refresh browser to test
3. No need to touch other files

### Working on Pharmacy Features
1. Edit `static/js/pharmacy.js`
2. Refresh browser to test
3. Independent of crew.js changes

### Adding New Features
1. Create new module in `static/js/` (e.g., `reports.js`)
2. Add script tag to `index.html` before `main.js`
3. Implement functionality
4. Call from `loadData()` in main.js if needed

## Testing

After refactoring, test these key workflows:
- [ ] Chat/Triage functionality
- [ ] Add/edit/delete crew members
- [ ] Auto-save in crew details
- [ ] Document upload (passport photos)
- [ ] Add/edit/delete medicines
- [ ] CSV import/export (crew and pharmacy)
- [ ] Settings save
- [ ] Vessel information save
- [ ] Tab navigation
- [ ] History display

## Backward Compatibility

The refactoring maintains 100% backward compatibility:
- Same API endpoints
- Same data structures
- Same UI/UX
- Same functionality

Only the code organization changed, not the behavior.

## Future Improvements

Potential next steps for further refactoring:

### Phase 2 (Optional):
- Extract CSS from inline styles to `static/css/style.css`
- Split HTML into template partials

### Phase 3 (Optional - Backend):
```
app.py → 
├── config.py      - Configuration & defaults
├── database.py    - Data operations
├── auth.py        - Authentication
├── models.py      - AI model loading
└── routes.py      - API endpoints
```

## Rollback Plan

If issues arise, restore from backup:
```bash
# The original file had all JavaScript inline
# Can be reconstructed by concatenating modules
```

## Questions?

Contact the development team or refer to individual module files for implementation details.
