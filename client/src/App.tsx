import React from 'react';
import './App.css';

export interface SystemStatus {
  service: string;
  status: string;
  timestamp: string;
}

const App: React.FC = () => {
  const initialStatus: SystemStatus = {
    service: 'NeuralNexus Frontend Client',
    status: 'online',
    timestamp: new Date().toISOString()
  };

  const teamModules = [
    {
      id: 1,
      name: 'Backend & Database',
      description: 'Node.js, Express & Database initialization & core API services.',
      status: 'Ready for integration'
    },
    {
      id: 2,
      name: 'AI Agents & Gemini',
      description: 'Multi-agent emergency response intelligence and dispatch reasoning.',
      status: 'Ready for integration'
    },
    {
      id: 3,
      name: 'Frontend & Mapbox',
      description: 'React, Vite, Mapbox live spatial crisis coordination dashboard.',
      status: 'Initialized'
    },
    {
      id: 4,
      name: 'Dynamic Replanning & Integration',
      description: 'Real-time adaptive resource coordination and constraint solver.',
      status: 'Ready for integration'
    }
  ];

  return (
    <div className="app-container">
      <header className="hero-section">
        <div className="badge">GATEWAYS 2026 Hackathon</div>
        <h1 className="title">NeuralNexus: Crisis Command</h1>
        <p className="subtitle">
          Multi-Agent Emergency Response & Resource Coordination Platform
        </p>
        <div className="status-indicator">
          <span className="dot"></span>
          <span>{initialStatus.service} - {initialStatus.status.toUpperCase()}</span>
        </div>
      </header>

      <section>
        <h2 className="team-section-title">Team Workspace Modules</h2>
        <div className="team-grid">
          {teamModules.map((module) => (
            <div key={module.id} className="team-card">
              <div className="card-header">
                <span className="card-role-num">Module {module.id}</span>
              </div>
              <h3 className="card-title">{module.name}</h3>
              <p className="card-desc">{module.description}</p>
              <div className="card-status">{module.status}</div>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer">
        NeuralNexus Base Scaffold &bull; Ready for independent module development
      </footer>
    </div>
  );
};

export default App;
