// Mocking the logic to see how it looks
let webcamActive = false;
let webcamTimer = null;
const host = "https://lava.taild5c213.ts.net";

function toggleWebcam() {
    webcamActive = !webcamActive;
    if (webcamActive) {
        console.log("Start polling");
        webcamTimer = setInterval(() => {
            const url = `${host}/webcam/?action=snapshot&t=${Date.now()}`;
            // img.src = url;
            console.log("Updating img to", url);
        }, 1000); // 1 fps
    } else {
        console.log("Stop polling");
        clearInterval(webcamTimer);
    }
}
toggleWebcam();
setTimeout(toggleWebcam, 3500);
