"""Builds the "Wochenduell Sync" iOS Shortcut as an unsigned shortcut file.

The Shortcut is the same for everyone. The app starts it with
  shortcuts://run-shortcut?name=Wochenduell%20Sync&input=text&text=<personal sync key>
For steps, active calories and calories eaten it reads the last 3 days from Health,
grouped by day, and sends one line per day ("yyyy-MM-dd;value") to health-sync as JSON:
  POST <health-sync>?format=text  {"key": <input>, "steps": "<lines>", ...}
The server keeps today and yesterday and answers with one sentence, which the Shortcut
shows as a notification. Each type is sent right after it is read, so a later type that
fails cannot lose the earlier ones.

Action structures follow shortcuts built in the Shortcuts app on a phone:
- type filter: Values.Enumeration {Value, WFStringSubstitutableState}; type names as the
  Shortcuts app uses them ("Steps", "Active Calories"), with WFHKSampleFilteringUnit set
- start date: Operator 1001 + {Unit: 16, Number: "3"} = "is in the last 3 days"
- WFHKSampleFilteringFillMissing: days without data become 0 instead of a blocking
  "no samples found" alert; the server ignores zeros
- per-day value via the "Repeat Item" variable with a Value property aggrandizement
Sign afterwards on a Mac:  shortcuts sign --mode anyone -i <unsigned> -o "Wochenduell Sync.shortcut"
"""
import plistlib
import sys
import uuid

OBJ = "￼"  # placeholder character marking where a variable sits inside text
BASE_URL = "https://pkkfxhxizhezovjgfbne.supabase.co/functions/v1/health-sync"
DAYS = "3"
# (JSON field, Shortcuts type name, unit); each is sent right after reading. The names are the
# Shortcuts app's own ("Active Calories", "Dietary Calories"), taken from the type list in
# WorkflowKit, not the Health app's ("Active Energy", "Dietary Energy"), which come back empty.
# A type the user has not allowed in Settings > Health > Shortcuts also comes back empty, no alert.
TYPES = (("steps", "Steps", "count"), ("active", "Active Calories", "kcal"), ("eaten", "Dietary Calories", "kcal"))

REPEAT_ITEM = {"Type": "Variable", "VariableName": "Repeat Item"}
VALUE_OF_ITEM = dict(REPEAT_ITEM, Aggrandizements=[{"Type": "WFPropertyVariableAggrandizement", "PropertyName": "Value"}])


class Builder:
    def __init__(self):
        self.actions = []

    def add(self, ident, params):
        params = {**params, "UUID": str(uuid.uuid4()).upper()}
        self.actions.append({"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params})
        return params["UUID"]

    @staticmethod
    def output(uid, name):
        return {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}

    @staticmethod
    def attach(ref):
        return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}

    @staticmethod
    def text(*parts):
        """Text token: plain strings mixed with variable refs (ranges count UTF-16 units)."""
        string, attachments = "", {}
        for part in parts:
            if isinstance(part, str):
                string += part
            else:
                attachments["{%d, 1}" % (len(string.encode("utf-16-le")) // 2)] = part
                string += OBJ
        value = {"string": string}
        if attachments:
            value["attachmentsByRange"] = attachments
        return {"Value": value, "WFSerializationType": "WFTextTokenString"}

    def health_samples(self, type_name, unit):
        templates = [
            {"Property": "Type", "Operator": 4, "Removable": False, "Bounded": True,
             "Values": {"Enumeration": {"Value": type_name, "WFSerializationType": "WFStringSubstitutableState"}}},
            {"Property": "Start Date", "Operator": 1001, "Removable": False, "Bounded": True,
             "Values": {"Unit": 16, "Number": DAYS}},
        ]
        return self.add("is.workflow.actions.filter.health.quantity", {
            "WFContentItemFilter": {
                "Value": {"WFActionParameterFilterPrefix": 1, "WFContentPredicateBoundedDate": False,
                          "WFActionParameterFilterTemplates": templates},
                "WFSerializationType": "WFContentPredicateTableTemplate",
            },
            "WFHKSampleFilteringGroupBy": "Day",
            "WFHKSampleFilteringUnit": unit,
            "WFHKSampleFilteringFillMissing": True,
            "WFContentItemSortProperty": "Start Date",
            "WFContentItemSortOrder": "Latest First",
            "WFContentItemLimitEnabled": False,
        })

    def daily_lines(self, samples_uid):
        """Repeat with each day: "yyyy-MM-dd;value". Returns the UUID whose output is the list."""
        group = str(uuid.uuid4()).upper()
        self.add("is.workflow.actions.repeat.each", {
            "WFInput": self.attach(self.output(samples_uid, "Health Samples")),
            "GroupingIdentifier": group, "WFControlFlowMode": 0,
        })
        start = self.add("is.workflow.actions.properties.health.quantity", {
            "WFInput": self.attach(REPEAT_ITEM), "WFContentItemPropertyName": "Start Date",
        })
        day = self.add("is.workflow.actions.format.date", {
            "WFDateFormatStyle": "Custom", "WFDateFormat": "yyyy-MM-dd",
            "WFDate": self.text(self.output(start, "Start Date")),
        })
        self.add("is.workflow.actions.gettext", {
            "WFTextActionText": self.text(self.output(day, "Formatted Date"), ";", VALUE_OF_ITEM),
        })
        return self.add("is.workflow.actions.repeat.each", {"GroupingIdentifier": group, "WFControlFlowMode": 2})

    def post(self, fields):
        def field(key, value):  # WFItemType 0 = text
            return {"WFKey": self.text(key), "WFItemType": 0, "WFValue": value}
        items = [field("key", self.text({"Type": "ExtensionInput"}))]
        items += [field(k, self.text(self.output(uid, "Repeat Results"))) for k, uid in fields]
        return self.add("is.workflow.actions.downloadurl", {
            "WFURL": BASE_URL + "?format=text",
            "WFHTTPMethod": "POST",
            "ShowHeaders": False,
            "WFJSONValues": {"Value": {"WFDictionaryFieldValueItems": items}, "WFSerializationType": "WFDictionaryFieldValue"},
        })


def build():
    b = Builder()
    sent, response = [], None
    for key, type_name, unit in TYPES:
        lines = b.daily_lines(b.health_samples(type_name, unit))
        sent.append((key, lines))
        response = b.post(sent)
    b.add("is.workflow.actions.notification", {
        "WFNotificationActionTitle": "Wochenduell",
        "WFNotificationActionBody": b.text(b.output(response, "Contents of URL")),
        "WFNotificationActionSound": False,
    })
    return {
        "WFWorkflowClientVersion": "2302.0.4",
        "WFWorkflowClientRelease": "16.0",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59843},
        "WFWorkflowImportQuestions": [],
        "WFWorkflowTypes": [],
        "WFWorkflowInputContentItemClasses": ["WFStringContentItem", "WFURLContentItem"],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowActions": b.actions,
    }


if __name__ == "__main__":
    out = sys.argv[1]
    with open(out, "wb") as fh:
        plistlib.dump(build(), fh, fmt=plistlib.FMT_BINARY)
    print("wrote", out)
