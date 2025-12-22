# ROS Annotator

**A lightweight, web-based visualization and annotation tool for Robotics (ROS 1) data.**

ROS Annotator is a React application designed to streamline the process of inspecting `.bag` files and creating semantic annotations for imitation learning and Vision-Language-Action (VLA) models. It runs entirely in the browser (local processing), offering a fluid interface for visualizing image topics, joint states, and 3D URDF models alongside a precise timeline.

## ✨ Key Features

### 📊 Visualization

* **Multi-Modal Playback:** Synchronized playback of camera feeds and joint states.
* **Customizable Layout:** Drag-and-drop image topics to reorder them. Layouts are automatically saved per bag structure.
* **Joint Analysis:** Interactive graphs for Joint Position, Velocity, and Effort using `Chart.js`.
* **URDF Viewer:** Integrated 3D visualization of the robot's joint state.

### 🏷️ Annotation System

* **Subtask Segmentation:** Divide long recordings into semantic subtasks (e.g., "Pick the red block").
* **Language Prompts:** Built-in generator for VLA prompts (Action + Adjective + Object).
* **Quality Labeling:** Tag segments as `Good`, `Bad`, or `Accident` for data filtering.
* **Contact Detection:** Dedicated timeline track for marking precise contact events (start/end).

### ⚡ Workflow Efficiency

* **Drag & Drop:** Load `.bag` files directly from your file system.
* **Timeline Interaction:** Zoom-independent, responsive scrubbing.
* **Context Menus:** Right-click on the timeline to split tasks or add events.
* **JSON Export:** Export structured annotations ready for machine learning pipelines.

## 🛠️ Tech Stack

* **Framework:** [React](https://react.dev/) (TypeScript)
* **Styling:** [Tailwind CSS](https://tailwindcss.com/)
* **Charts:** [Chart.js](https://www.chartjs.org/) with `chartjs-plugin-annotation`
* **Robotics:** Custom `BagService` for parsing, URDF visualization components.
* **Icons:** SVG / Heroicons

## 🚀 Getting Started

### Prerequisites

* Node.js (v16+)
* npm or yarn

### Installation

1. **Clone the repository:**
```bash
git clone https://github.com/your-username/ros-annotator.git
cd ros-annotator

```


2. **Install dependencies:**
```bash
npm install
# or
yarn install

```


3. **Run the development server:**
```bash
npm run dev

```


4. Open `http://localhost:5173` (or the port shown in your terminal) in your browser.

## 📖 Usage Guide

### 1. Loading Data

simply drag and drop a `.bag` file onto the landing screen. The application parses the file locally.

### 2. The Timeline

* **Red Line:** Indicates the current frame. Click anywhere to jump.
* **White Line:** Hover cursor.
* **Subtask Track (Top):**
* **Right-Click:** Splits the current subtask at the cursor location.
* **Merge:** Use the "Merge Prev" / "Merge Next" buttons in the sidebar to combine segments.


* **Contact Track (Bottom):**
* **Right-Click:** Starts a "Pending" contact region. Right-click again to finish it.
* **Drag:** Drag the edges of a contact block to resize it, or the center to move it.



### 3. Annotation Properties

Select a Subtask or Contact on the timeline to open the **Properties Panel** on the right:

* **Prompt:** Construct a sentence using the dropdowns or type manually.
* **Quality:** Mark the success rate of the trajectory.
* **Delete:** Remove contacts using the "Delete" button or `Del`/`Backspace` key.

### 4. Exporting

Click the **Export JSON** button in the header. This will download a JSON file containing the file metadata and all annotations.

## 📂 Output Format

The exported JSON follows this structure:

```json
{
  "filename": "demo_data.bag",
  "metadata": {
    "totalFrames": 1500,
    "duration": 45000
  },
  "subtasks": [
    {
      "id": "unique-id",
      "username": "local",
      "start": 0,
      "end": 500,
      "quality": "good",
      "prompt": "pick the red cube"
    }
  ],
  "contacts": [
    {
      "id": "unique-id",
      "username": "local",
      "start": 200,
      "end": 215
    }
  ]
}

```

## ⌨️ Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Toggle Play/Pause |
| `Delete` / `Backspace` | Delete selected Contact |
| `Shift` + `Scroll` | (Previous functionality) - Zoom removed for stability |

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.