function setupEnvironmentVariables() {
  // 1. Enter your values here
  // LEAVE BLANK or use "[value]" to skip updating that specific property
  var newProperties = {
    'GEMINI_API_KEY': '[GEMINI API KEY]', // Existing key
    'TRELLO_LABEL': '[label:Trello]',
    'GEMINI_MODEL': '[gemini-2.5-flash]',
    'WEBHOOK_URL': '[YOUR_WEBHOOK_URL_HERE]',
    'WEBHOOK_MODE': '[URL_PARAM]', // Options: 'JSON', 'TEXT', 'URL_PARAM'
    'WEBHOOK_PARAM_NAME': '[parameter]', // Only used if mode is URL_PARAM
    'ENABLE_DESTRUCTIVE_ACTIONS': 'false' // 'true' or 'false'
  };

  // 2. Iterate and only save VALID values
  // detailed check: not empty, not null, not enclosed in []
  var propsToSave = {};
  var scriptProperties = PropertiesService.getScriptProperties();

  for (var key in newProperties) {
    var value = newProperties[key];

    // Check for "placeholder" values
    var isPlaceholder = (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']'));
    var isEmpty = (!value || value.toString().trim() === "");

    if (isEmpty || isPlaceholder) {
      Logger.log(`⚠️ Skipping '${key}': Value is empty or placeholder.`);
    } else {
      propsToSave[key] = value;
      Logger.log(`✅ Queued '${key}' for update.`);
    }
  }

  // 3. Save to Script Properties (Merge, does not delete missing keys)
  if (Object.keys(propsToSave).length > 0) {
    scriptProperties.setProperties(propsToSave);
    Logger.log("🎉 Settings saved successfully!");
  } else {
    Logger.log("⚠️ No valid settings found to save.");
  }
}