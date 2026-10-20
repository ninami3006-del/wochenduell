"""Builds the "Wochenduell Sync" iOS Shortcut as an unsigned shortcut file.

The Shortcut is the same for everyone. The app starts it with
  shortcuts://run-shortcut?name=Wochenduell%20Sync&input=text&text=<personal sync URL>
and the Shortcut appends today's values:
  <personal sync URL>&steps=<n>&active=<n>&eaten=<n>

Action format copied from a Shortcut exported by iOS (Find Health Samples grouped by day).
Sign afterwards on a Mac:  shortcuts sign --mode anyone -i <unsigned> -o "Wochenduell Sync.shortcut"
"""
import plistlib
import sys
import uuid

OBJ = "￼"  # placeholder character for a variable inside text


def uid():
    return str(uuid.uuid4()).upper()


def find_today(type_name, action_uuid):
    """Find Health Samples: <type>, start date in the last day, grouped by day,
    missing days filled with zero, newest first, only 1 -> today's total."""
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.filter.health.quantity",
        "WFWorkflowActionParameters": {
            "UUID": action_uuid,
            "WFHKSampleFilteringGroupBy": "Day",
            "WFHKSampleFilteringFillMissing": True,
            "WFContentItemSortProperty": "Start Date",
            "WFContentItemSortOrder": "Latest First",
            "WFContentItemLimitEnabled": True,
            "WFContentItemLimitNumber": 1.0,
            "WFContentItemFilter": {
                "Value": {
                    "WFActionParameterFilterPrefix": 1,
                    "WFContentPredicateBoundedDate": False,
                    "WFActionParameterFilterTemplates": [
                        {"Property": "Type", "Operator": 4, "VariableOverrides": {},
                         "Enumeration": type_name, "Removable": False, "Bounded": True},
                        {"Property": "Start Date", "Operator": 1001, "Number": 1, "Unit": 16,
                         "VariableOverrides": {}, "Removable": False, "Bounded": True},
                    ],
                },
                "WFSerializationType": "WFContentPredicateTableTemplate",
            },
        },
    }


def sample_value(action_uuid):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.properties.health.quantity",
        "WFWorkflowActionParameters": {"UUID": action_uuid, "WFContentItemPropertyName": "Value"},
    }


def round_whole(action_uuid):
    return {
        "WFWorkflowActionIdentifier": "is.workflow.actions.round",
        "WFWorkflowActionParameters": {"UUID": action_uuid, "WFRoundDecimalPlaces": 0.0, "WFRoundType": "Right of Decimal"},
    }


def token_string(parts):
    """parts: list of plain strings or attachment dicts -> WFTextTokenString."""
    text, attachments = "", {}
    for p in parts:
        if isinstance(p, str):
            text += p
        else:
            position = len(text.encode("utf-16-le")) // 2  # ranges count UTF-16 units
            attachments["{%d, 1}" % position] = p
            text += OBJ
    return {"Value": {"string": text, "attachmentsByRange": attachments}, "WFSerializationType": "WFTextTokenString"}


def output(action_uuid, name):
    return {"Type": "ActionOutput", "OutputUUID": action_uuid, "OutputName": name}


def build():
    actions = []
    rounded = {}
    for key, hk_type in (("steps", "Steps"), ("active", "Active Energy"), ("eaten", "Dietary Energy")):
        f, v, r = uid(), uid(), uid()
        actions += [find_today(hk_type, f), sample_value(v), round_whole(r)]
        rounded[key] = r

    url = token_string([
        {"Type": "ExtensionInput"},
        "&steps=", output(rounded["steps"], "Rounded Number"),
        "&active=", output(rounded["active"], "Rounded Number"),
        "&eaten=", output(rounded["eaten"], "Rounded Number"),
    ])
    actions.append({
        "WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
        "WFWorkflowActionParameters": {"UUID": uid(), "WFURL": url, "WFHTTPMethod": "GET"},
    })
    actions.append({
        "WFWorkflowActionIdentifier": "is.workflow.actions.notification",
        "WFWorkflowActionParameters": {
            "UUID": uid(),
            "WFNotificationActionTitle": "Wochenduell",
            "WFNotificationActionBody": "Werte aus Apple Health übernommen. / Values sent from Apple Health.",
            "WFNotificationActionSound": False,
        },
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
        "WFWorkflowActions": actions,
    }


if __name__ == "__main__":
    out = sys.argv[1]
    with open(out, "wb") as fh:
        plistlib.dump(build(), fh, fmt=plistlib.FMT_BINARY)
    print("wrote", out)
