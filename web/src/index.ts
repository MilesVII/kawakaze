import { define as defineRadio }       from "@rampike/radio";
import { define as defineTabs }        from "@rampike/tabs";
import { define as defineModal }       from "@rampike/modal";
import { define as definePages }       from "@rampike/pagination";
import { define as defineSVGImport }   from "@rampike/import";
import { define as defineFilePicker}   from "@rampike/filepicker";
import { define as defineLabeled }     from "@rampike/fieldset";
import { define as defineImagePicker } from "@rampike/imagepicker";
import { define as defineKonSwiper } from "@rampike/kon";
import { navigationUnit } from "@units/navigation";
import { settingsUnit }   from "@units/settings";
import { chatUnit }       from "@units/chat";
import { mainUnit }       from "@units/main";
import { scenarioUnit }   from "@units/scenario";
import { init as initPersist } from "./persist";
import { libraryUnit } from "@units/library";
import { toast, toastsUnit } from "@units/toasts";
import { docsUnit } from "@units/docs";
import { cheatsUnit } from "@units/cheats";
import { homeUnit } from "@units/kawa/home";
import { scenarioPageUnit } from "@units/kawa/scenario-page";
import { userPageUnit } from "@units/kawa/user-page";
import { profileUnit } from "@units/kawa/profile";
import { adminUnit } from "@units/kawa/admin";
import { termsUnit } from "@units/kawa/misc";
import { blacklistUnit } from "@units/kawa/blacklist";
import { mediaLibraryUnit } from "@units/kawa/media-library";
import { init as initKirov } from "@units/kirov";
import { account } from "./api";

defineTabs();
defineRadio();
defineModal("ram-modal");
definePages();
defineSVGImport("ram-import");
defineFilePicker("ram-file-picker");
defineImagePicker("ram-image-picker");
defineLabeled("ram-labeled");
defineKonSwiper();

window.addEventListener("DOMContentLoaded", main);

const units: (() => void)[] = [
	// first, so it hears modals other units open on start
	toastsUnit,
	navigationUnit,
	settingsUnit,
	chatUnit,
	mainUnit,
	libraryUnit,
	scenarioUnit,
	docsUnit,
	cheatsUnit,
	homeUnit,
	scenarioPageUnit,
	userPageUnit,
	profileUnit,
	adminUnit,
	termsUnit,
	blacklistUnit,
	mediaLibraryUnit
];

async function main() {
	initKirov();
	units.forEach(u => u());
	account.refresh();

	const dbAvailable = await initPersist();
	if (!dbAvailable) toast("indexeddb init failed");
}
